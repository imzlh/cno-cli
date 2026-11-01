import { deepStrictEqual, rejects, strictEqual } from 'node:assert';
import { file, write } from 'bun';
import { join } from 'node:path';
import { withTempDir } from '../_helpers/temp.ts';

Deno.test('bun: file stat, unlink and delete operate on the backing path', async () => {
    await withTempDir('bun-file-stat', async root => {
        const path = join(root, 'data');
        const target = file(path);
        await rejects(() => target.stat(), { code: 'ENOENT' });
        await rejects(() => target.unlink(), { code: 'ENOENT' });
        await write(path, 'abcdef');
        const sliced = target.slice(1, 3);
        const stats = await sliced.stat();
        strictEqual(stats.size, 6);
        strictEqual(stats.isFile(), true);
        strictEqual(stats.isDirectory(), false);
        strictEqual(stats.mtime instanceof Date, true);
        strictEqual(await sliced.unlink(), undefined);
        strictEqual(await target.exists(), false);
        await rejects(() => target.delete(), { code: 'ENOENT' });
        await write(path, 'again');
        strictEqual(await target.delete(), undefined);
        strictEqual(await target.exists(), false);
    });
});

Deno.test('bun: file write replaces the backing path and accepts Bun inputs', async () => {
    await withTempDir('bun-file-write', async root => {
        const path = join(root, 'nested', 'data');
        const target = file(path);
        strictEqual(await target.write('hello'), 5);
        strictEqual(await target.slice(1, 2).write(new Uint8Array([65, 66, 67])), 3);
        strictEqual(await target.text(), 'ABC');
        strictEqual(await target.write(new Blob(['blob'])), 4);
        strictEqual(await target.write(new Response('response')), 8);
        strictEqual(await target.text(), 'response');
        strictEqual(await target.write(new Request('http://example.test', { method: 'POST', body: 'request' })), 7);
        strictEqual(await target.text(), 'request');
        const stream = new ReadableStream({ start(controller) {
            controller.enqueue('hi');
            controller.enqueue(new Uint8Array([33]));
            controller.close();
        } });
        strictEqual(await target.write(stream), 3);
        strictEqual(await target.text(), 'hi!');
        strictEqual(await target.write('x', { highWaterMark: 1 }), 1);
        deepStrictEqual(Array.from(await target.bytes()), [120]);
        strictEqual(await target.write('y', { unsupported: true } as never), 1);
        strictEqual(await target.write('z', null as never), 1);
        await rejects(() => target.write('x', 1 as never), TypeError);
        await rejects(() => target.write(null as never), TypeError);
    });
});
