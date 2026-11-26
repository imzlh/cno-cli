import { deepStrictEqual, notStrictEqual, ok, strictEqual, throws } from 'node:assert';
import { serve } from 'bun';
import { decodeUtf8, encodeUtf8 } from '../_helpers/bytes.ts';

async function waitFor(condition: () => boolean, message: string): Promise<void> {
    const deadline = Date.now() + 2000;
    while (!condition()) {
        if (Date.now() >= deadline) throw new Error(message);
        await new Promise(resolve => setTimeout(resolve, 1));
    }
}

Deno.test({ name: 'bun.serve lifecycle: tracks concurrent handlers and response bodies through graceful stop', timeout: 5000 }, async () => {
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const requests = new Map<string, Request>();
    let body!: ReadableStreamDefaultController<Uint8Array>;
    const server = serve({
        hostname: '127.0.0.1', port: 0,
        async fetch(request) {
            const path = new URL(request.url).pathname;
            requests.set(path, request);
            if (path === '/held') {
                entered.resolve();
                await release.promise;
                return new Response('released');
            }
            return new Response(new ReadableStream({
                start(controller) { body = controller; controller.enqueue(encodeUtf8('stream')); },
            }));
        },
    });
    const observer = serve({ hostname: '127.0.0.1', port: 0, fetch() { return new Response('unused'); } });
    try {
        strictEqual(server.requestIP(new Request(server.url)), null);
        throws(() => server.requestIP({} as Request), TypeError);
        const held = fetch(new URL('/held', server.url));
        await entered.promise;
        strictEqual(server.pendingRequests, 1);
        const heldRequest = requests.get('/held')!;
        const peer = server.requestIP(heldRequest)!;
        strictEqual(peer.address, '127.0.0.1');
        strictEqual(peer.family, 'IPv4');
        ok(peer.port > 0 && peer.port !== server.port);
        deepStrictEqual(observer.requestIP(heldRequest), peer);
        strictEqual(observer.pendingRequests, 0);
        strictEqual(server.requestIP(heldRequest.clone()), null);
        const anotherPeer = server.requestIP(heldRequest);
        deepStrictEqual(anotherPeer, peer);
        notStrictEqual(anotherPeer, peer);
        peer.address = 'changed';
        strictEqual(server.requestIP(heldRequest)?.address, '127.0.0.1');

        const streaming = await fetch(new URL('/stream', server.url));
        const reader = streaming.body!.getReader();
        strictEqual(decodeUtf8((await reader.read()).value!), 'stream');
        strictEqual(server.pendingRequests, 2);
        release.resolve();
        strictEqual(await (await held).text(), 'released');
        await waitFor(() => server.pendingRequests === 1, 'finished handler remained pending');
        strictEqual(server.requestIP(heldRequest), null);
        strictEqual(observer.requestIP(heldRequest), null);
        ok(server.requestIP(requests.get('/stream')!));

        let stopped = false;
        const stop = server.stop().then(() => { stopped = true; });
        await Promise.resolve();
        strictEqual(stopped, false);
        strictEqual(server.pendingRequests, 1);
        body.close();
        strictEqual((await reader.read()).done, true);
        await stop;
        strictEqual(server.pendingRequests, 0);
        strictEqual(server.requestIP(requests.get('/stream')!), null);
        strictEqual(server.ref(), server);
        strictEqual(server.unref(), server);
    } finally {
        release.resolve();
        try { body?.close(); } catch {}
        await server.stop();
        await observer.stop();
    }
});

Deno.test({ name: 'bun.serve lifecycle: releases HEAD and recovered errors after transport completion', timeout: 5000 }, async () => {
    const cancelled = Promise.withResolvers<void>();
    let request!: Request;
    let errorPending = 0;
    let errorAddress: unknown;
    let body!: ReadableStreamDefaultController<Uint8Array>;
    const server = serve({
        hostname: '127.0.0.1', port: 0,
        fetch(current) {
            request = current;
            if (current.method === 'HEAD') {
                return new Response(new ReadableStream({
                    cancel() { cancelled.resolve(); return new Promise(() => {}); },
                }));
            }
            throw new Error('recoverable');
        },
        error() {
            errorPending = server.pendingRequests;
            errorAddress = server.requestIP(request);
            return new Response(new ReadableStream({
                start(controller) { body = controller; controller.enqueue(encodeUtf8('recovered')); },
            }), { status: 503 });
        },
    });
    try {
        const head = await fetch(server.url, { method: 'HEAD' });
        strictEqual(await head.text(), '');
        await cancelled.promise;
        await waitFor(() => server.pendingRequests === 0, 'HEAD waited for producer cancellation');
        strictEqual(server.requestIP(request), null);

        const response = await fetch(server.url);
        strictEqual(response.status, 503);
        strictEqual(errorPending, 1);
        ok(errorAddress);
        strictEqual(server.pendingRequests, 1);
        const text = response.text();
        body.close();
        strictEqual(await text, 'recovered');
        await waitFor(() => server.pendingRequests === 0, 'recovered response remained pending');
        strictEqual(server.requestIP(request), null);
    } finally {
        try { body?.close(); } catch {}
        await server.stop();
    }
});

Deno.test({ name: 'bun.serve lifecycle: disconnect clears requests without waiting for producer cancellation', timeout: 5000 }, async () => {
    const cancelled = Promise.withResolvers<void>();
    let request!: Request;
    let abortedAddress: unknown = 'not aborted';
    const server = serve({
        hostname: '127.0.0.1', port: 0,
        fetch(current) {
            request = current;
            current.signal.addEventListener('abort', () => { abortedAddress = server.requestIP(current); }, { once: true });
            return new Response(new ReadableStream({
                start(controller) { controller.enqueue(encodeUtf8('started')); },
                cancel() { cancelled.resolve(); return new Promise(() => {}); },
            }));
        },
    });
    const controller = new AbortController();
    try {
        const response = await fetch(server.url, { signal: controller.signal });
        const reader = response.body!.getReader();
        strictEqual(decodeUtf8((await reader.read()).value!), 'started');
        strictEqual(server.pendingRequests, 1);
        ok(server.requestIP(request));
        controller.abort();
        await reader.read().catch(() => {});
        await cancelled.promise;
        await waitFor(() => server.pendingRequests === 0, 'disconnected request remained pending');
        strictEqual(abortedAddress, null);
        strictEqual(server.requestIP(request), null);
    } finally {
        controller.abort();
        await server.stop();
    }
});

Deno.test({ name: 'bun.serve lifecycle: upgrade retires the HTTP address and request count before socket close', timeout: 5000 }, async () => {
    let request!: Request;
    let beforeUpgrade: unknown;
    let afterUpgrade: unknown;
    let errors = 0;
    const server = serve({
        hostname: '127.0.0.1', port: 0,
        fetch(current, server) {
            request = current;
            beforeUpgrade = server.requestIP(current);
            if (!server.upgrade(current)) return new Response('upgrade failed', { status: 400 });
            afterUpgrade = server.requestIP(current);
            throw new Error('after upgrade');
        },
        error() { errors++; return new Response('ignored'); },
        websocket: { message() {} },
    });
    const socket = new WebSocket(`ws://127.0.0.1:${server.port}/`);
    try {
        await new Promise<void>((resolve, reject) => {
            socket.addEventListener('open', () => resolve(), { once: true });
            socket.addEventListener('error', reject, { once: true });
        });
        ok(beforeUpgrade);
        strictEqual(afterUpgrade, null);
        strictEqual(server.requestIP(request), null);
        await waitFor(() => server.pendingRequests === 0, 'upgrade remained an HTTP request');
        strictEqual(server.pendingWebSockets, 1);
        strictEqual(errors, 1);
    } finally {
        const closed = new Promise(resolve => socket.addEventListener('close', resolve, { once: true }));
        socket.close();
        await closed;
        await server.stop();
    }
    strictEqual(server.pendingRequests, 0);
    strictEqual(server.pendingWebSockets, 0);
});

Deno.test({ name: 'bun.serve lifecycle: ref and unref control listener ownership', timeout: 7000 }, async () => {
    for (const refAgain of [false, true]) {
        const source = `
            import { serve } from 'bun';
            const server = serve({ hostname: '127.0.0.1', port: 0, fetch() { return new Response('unused'); } });
            server.unref();
            ${refAgain ? 'server.ref();' : ''}
            const timer = setTimeout(() => { console.log('timer'); void server.stop(); }, 100);
            timer.unref();
            console.log('ready');
        `;
        const child = new Deno.Command(Deno.execPath().replace(/ \(deleted\)$/, ''), {
            args: ['eval', '--no-lock', source], stdout: 'piped', stderr: 'piped',
        }).spawn();
        const deadline = setTimeout(() => { try { child.kill('SIGKILL'); } catch {} }, 2500);
        try {
            const output = await child.output();
            strictEqual(output.code, 0, decodeUtf8(output.stderr));
            strictEqual(decodeUtf8(output.stdout), refAgain ? 'ready\ntimer\n' : 'ready\n');
        } finally {
            clearTimeout(deadline);
            try { child.kill('SIGKILL'); } catch {}
        }
    }
});
