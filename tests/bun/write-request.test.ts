import { deepStrictEqual, rejects, strictEqual } from 'node:assert';
import Bun, { file, write } from 'bun';
import { join } from 'node:path';
import { withTempDir } from '../_helpers/temp.ts';

function requestWithBody(body: BodyInit): Request {
    const init: RequestInit = { method: 'POST', body };
    // Fetch requires an explicit duplex mode for streaming request bodies.
    if (body instanceof ReadableStream) init.duplex = 'half';
    return new Request('https://example.invalid/upload', init);
}

Deno.test({ name: 'bun: top-level write streams Request bodies without materializing them', timeout: 10000 }, async () => {
    await withTempDir('bun-write-request-stream', async root => {
        const path = join(root, 'output.bin');
        let chunks = 0;
        const request = requestWithBody(new ReadableStream<Uint8Array>({
            pull(controller) {
                if (chunks === 12) {
                    controller.close();
                    return;
                }
                controller.enqueue(new Uint8Array(64 * 1024).fill(chunks++));
            },
        }));
        request.arrayBuffer = async () => { throw new Error('must not materialize a Request'); };

        strictEqual(Bun.write, write);
        strictEqual(await write(path, request), 12 * 64 * 1024);
        strictEqual(request.bodyUsed, true);
        const bytes = await file(path).bytes();
        for (let chunk = 0; chunk < 12; chunk++) {
            strictEqual(bytes[chunk * 64 * 1024], chunk);
            strictEqual(bytes[(chunk + 1) * 64 * 1024 - 1], chunk);
        }
    });
});

Deno.test('bun: top-level write uses Request stream view windows, not shadowing properties', async () => {
    await withTempDir('bun-write-request-views', async root => {
        const path = join(root, 'output.bin');
        const backing = new Uint8Array([9, 65, 66, 9]);
        const chunks: ArrayBufferView[] = [
            new Uint8Array(backing.buffer, 1, 2),
            new DataView(backing.buffer, 1, 2),
        ];
        for (const chunk of chunks) {
            Object.defineProperties(chunk, {
                buffer: { value: new ArrayBuffer(0) },
                byteOffset: { value: 0 },
                byteLength: { value: 0 },
            });
        }
        const request = requestWithBody(new ReadableStream<ArrayBufferView>({
            start(controller) {
                for (const chunk of chunks) controller.enqueue(chunk);
                controller.close();
            },
        }) as unknown as BodyInit);

        strictEqual(await write(path, request), 4);
        deepStrictEqual(await file(path).bytes(), new Uint8Array([65, 66, 65, 66]));
    });
});

Deno.test('bun: top-level write treats detached Request stream views as empty chunks', async () => {
    await withTempDir('bun-write-request-detached', async root => {
        const path = join(root, 'output.bin');
        const backing = new ArrayBuffer(4);
        const chunks: ArrayBufferView[] = [
            new Uint8Array(backing, 1, 2),
            new DataView(backing, 1, 2),
        ];
        structuredClone(backing, { transfer: [backing] });
        const request = requestWithBody(new ReadableStream<ArrayBufferView>({
            start(controller) {
                for (const chunk of chunks) controller.enqueue(chunk);
                controller.close();
            },
        }) as unknown as BodyInit);

        await write(path, 'original');
        strictEqual(await write(path, request), 0);
        deepStrictEqual(await file(path).bytes(), new Uint8Array(0));
    });
});

Deno.test('bun: top-level write truncates for bodyless Requests and honors createPath', async () => {
    await withTempDir('bun-write-request-empty', async root => {
        const path = join(root, 'nested', 'output.txt');
        await rejects(() => write(path, requestWithBody('x'), { createPath: false }));
        strictEqual(await file(path).exists(), false);

        await write(path, 'existing content');
        strictEqual(await write(path, new Request('https://example.invalid/empty')), 0);
        strictEqual(await file(path).text(), '');
    });
});

Deno.test('bun: top-level write rejects used and locked Request bodies without changing the target', async () => {
    await withTempDir('bun-write-request-state', async root => {
        const path = join(root, 'output.txt');
        await write(path, 'original');

        const used = requestWithBody('used');
        await used.text();
        await rejects(() => write(path, used), /Request body is already used or locked/);
        strictEqual(await file(path).text(), 'original');

        const locked = requestWithBody('locked');
        const reader = locked.body!.getReader();
        try {
            await rejects(() => write(path, locked), /Request body is already used or locked/);
            strictEqual(await file(path).text(), 'original');
        } finally {
            await reader.cancel();
            reader.releaseLock();
        }

        deepStrictEqual(await file(path).bytes(), new TextEncoder().encode('original'));
    });
});
