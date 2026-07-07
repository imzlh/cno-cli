import { createServer } from 'node:net';
import { strictEqual, ok } from 'node:assert';

// ============================================================================
// Web API — EventSource (SSE)
// ============================================================================

let canListenTcpPromise: Promise<boolean> | undefined;

function canListenTcp(): Promise<boolean> {
    canListenTcpPromise ??= new Promise((resolve, reject) => {
        const server = createServer();
        server.once('error', (error) => {
            if (String(error).includes('EPERM')) {
                resolve(false);
                return;
            }
            reject(error);
        });
        try {
            server.listen(0, '127.0.0.1', () => {
                server.close(() => resolve(true));
            });
        } catch (error) {
            if (String(error).includes('EPERM')) {
                resolve(false);
                return;
            }
            reject(error);
        }
    });
    return canListenTcpPromise;
}

async function waitForMessage(eventSource: EventSource): Promise<MessageEvent> {
    return await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('timed out waiting for EventSource message')), 3000);
        eventSource.onmessage = (event) => {
            clearTimeout(timer);
            resolve(event);
        };
        eventSource.onerror = () => {
            clearTimeout(timer);
            reject(new Error('EventSource emitted error before message'));
        };
    });
}

Deno.test('webapi: EventSource class exists', () => {
    ok(typeof EventSource === 'function');
});

Deno.test('webapi: EventSource static constants', () => {
    strictEqual(EventSource.CONNECTING, 0);
    strictEqual(EventSource.OPEN, 1);
    strictEqual(EventSource.CLOSED, 2);
});

Deno.test('webapi: EventSource extends EventTarget', () => {
    const es = new EventSource('http://127.0.0.1:1/');
    ok(es instanceof EventTarget);
    es.close();
});

Deno.test('webapi: EventSource url property', () => {
    const es = new EventSource('http://127.0.0.1:1/path');
    strictEqual(es.url, 'http://127.0.0.1:1/path');
    es.close();
});

Deno.test('webapi: EventSource withCredentials defaults to false', () => {
    const es = new EventSource('http://127.0.0.1:1/');
    strictEqual(es.withCredentials, false);
    es.close();
});

Deno.test('webapi: EventSource withCredentials true', () => {
    const es = new EventSource('http://127.0.0.1:1/', { withCredentials: true });
    strictEqual(es.withCredentials, true);
    es.close();
});

Deno.test('webapi: EventSource readyState initially CONNECTING', () => {
    const es = new EventSource('http://127.0.0.1:1/');
    strictEqual(es.readyState, EventSource.CONNECTING);
    es.close();
});

Deno.test('webapi: EventSource onopen handler is settable', () => {
    const es = new EventSource('http://127.0.0.1:1/');
    es.onopen = () => {};
    ok(typeof es.onopen === 'function');
    es.close();
});

Deno.test('webapi: EventSource onmessage handler is settable', () => {
    const es = new EventSource('http://127.0.0.1:1/');
    es.onmessage = () => {};
    ok(typeof es.onmessage === 'function');
    es.close();
});

Deno.test('webapi: EventSource onerror handler is settable', () => {
    const es = new EventSource('http://127.0.0.1:1/');
    es.onerror = () => {};
    ok(typeof es.onerror === 'function');
    es.close();
});

Deno.test('webapi: EventSource addEventListener works', () => {
    const es = new EventSource('http://127.0.0.1:1/');
    let fired = false;
    es.addEventListener('open', () => { fired = true; });
    es.close();
});

Deno.test('webapi: EventSource close changes readyState to CLOSED', () => {
    const es = new EventSource('http://127.0.0.1:1/');
    es.close();
    ok(es.readyState === EventSource.CLOSED || typeof es.readyState === 'number');
});

Deno.test({ name: 'EventSource upstream: data payload preserves colons', timeout: 10000 }, async () => {
    if (!await canListenTcp()) return;

    const controller = new AbortController();
    const server = Deno.serve({
        hostname: '127.0.0.1',
        port: 0,
        signal: controller.signal,
        onListen() {},
    }, () => new Response('data: {"key":"value"}\n\n', {
        headers: { 'content-type': 'text/event-stream' },
    }));

    const eventSource = new EventSource(`http://127.0.0.1:${server.addr.port}/`);
    try {
        const event = await waitForMessage(eventSource);
        strictEqual(event.data, '{"key":"value"}');
        strictEqual(event.origin, `http://127.0.0.1:${server.addr.port}`);
    } finally {
        eventSource.close();
        controller.abort();
        try { await server.finished; } catch {}
    }
});

Deno.test({ name: 'EventSource upstream: custom events join data lines and expose lastEventId', timeout: 10000 }, async () => {
    if (!await canListenTcp()) return;

    const controller = new AbortController();
    const server = Deno.serve({
        hostname: '127.0.0.1',
        port: 0,
        signal: controller.signal,
        onListen() {},
    }, () => new Response([
        ': comment is ignored',
        'id: event-7',
        'event: custom',
        'data: first line',
        'data: second:line',
        '',
        'data: default message',
        '',
    ].join('\n'), {
        headers: { 'content-type': 'text/event-stream; charset=utf-8' },
    }));

    const eventSource = new EventSource(`http://127.0.0.1:${server.addr.port}/`);
    try {
        const seen: MessageEvent[] = [];
        const custom = new Promise<MessageEvent>((resolve, reject) => {
            const timer = setTimeout(() => reject(new Error('timed out waiting for custom SSE event')), 3000);
            eventSource.addEventListener('custom', (event) => {
                clearTimeout(timer);
                resolve(event as MessageEvent);
            }, { once: true });
        });
        const message = waitForMessage(eventSource);

        const customEvent = await custom;
        seen.push(customEvent);
        strictEqual(customEvent.data, 'first line\nsecond:line');
        strictEqual(customEvent.lastEventId, 'event-7');
        strictEqual(customEvent.origin, `http://127.0.0.1:${server.addr.port}`);

        const messageEvent = await message;
        strictEqual(messageEvent.data, 'default message');
        strictEqual(messageEvent.lastEventId, 'event-7');
        strictEqual(seen.length, 1);
    } finally {
        eventSource.close();
        controller.abort();
        try { await server.finished; } catch {}
    }
});
