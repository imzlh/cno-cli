import { deepStrictEqual, rejects, strictEqual, throws } from 'node:assert';
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

Deno.test('bun: file Blob methods expose Bun metadata and preserve Blob receiver brands', async () => {
    const target = file(new URL(import.meta.url));
    const prototype = Object.getPrototypeOf(target) as typeof target;

    strictEqual(prototype.slice.name, 'slice');
    strictEqual(prototype.slice.length, 2);
    strictEqual(Object.hasOwn(prototype.slice, 'prototype'), false);
    strictEqual(prototype.stream.name, 'stream');
    strictEqual(prototype.stream.length, 1);
    strictEqual(Object.hasOwn(prototype.stream, 'prototype'), false);

    const blob = new Blob(['abcdef'], { type: 'text/plain' });
    const originalSlice = Blob.prototype.slice;
    const originalStream = Blob.prototype.stream;
    try {
        Blob.prototype.slice = () => { throw new Error('patched Blob.slice called'); };
        Blob.prototype.stream = () => { throw new Error('patched Blob.stream called'); };

        const sliced = Reflect.apply(prototype.slice, blob, [1, 4, 'text/custom']);
        strictEqual(await sliced.text(), 'bcd');
        strictEqual(sliced.type, 'text/custom');
        const stream = Reflect.apply(prototype.stream, blob, [1]);
        strictEqual(await new Response(stream).text(), 'abcdef');
    } finally {
        Blob.prototype.slice = originalSlice;
        Blob.prototype.stream = originalStream;
    }

    const fake = Object.create(Blob.prototype);
    throws(() => Reflect.apply(prototype.slice, fake, [0, 1]), TypeError);
    throws(() => Reflect.apply(prototype.stream, fake, []), TypeError);
    throws(() => Reflect.apply(prototype.slice, new Proxy(blob, {}), [0, 1]), TypeError);
    throws(() => Reflect.apply(prototype.stream, new Proxy(blob, {}), []), TypeError);
});

Deno.test('bun: file metadata and exists preserve Blob receiver brands and descriptors', async () => {
    const target = file(new URL(import.meta.url));
    const prototype = Object.getPrototypeOf(target);
    const name = Object.getOwnPropertyDescriptor(prototype, 'name')!;
    const lastModified = Object.getOwnPropertyDescriptor(prototype, 'lastModified')!;
    const exists = Object.getOwnPropertyDescriptor(prototype, 'exists')!;

    for (const property of [
        'name', 'type', 'size', 'lastModified',
        'slice', 'stream', 'bytes', 'arrayBuffer', 'text', 'json',
        'exists', 'stat', 'unlink', 'delete', 'write', 'writer',
    ]) {
        const descriptor = Object.getOwnPropertyDescriptor(prototype, property)!;
        strictEqual(descriptor.enumerable, true, property);
        strictEqual(descriptor.configurable, false, property);
        if ('value' in descriptor) strictEqual(descriptor.writable, true, property);
    }

    deepStrictEqual(
        { get: name.get?.name, set: name.set?.name },
        { get: 'get name', set: 'set name' },
    );
    deepStrictEqual(
        { get: lastModified.get?.name, set: lastModified.set },
        { get: 'get lastModified', set: undefined },
    );
    deepStrictEqual(
        { name: exists.value.name, length: exists.value.length, constructible: Object.hasOwn(exists.value, 'prototype') },
        { name: 'exists', length: 0, constructible: false },
    );

    const blob = new Blob(['value']);
    const webFile = new File(['value'], 'value.txt', { lastModified: 1234 });
    strictEqual(Reflect.apply(name.get!, blob, []), undefined);
    strictEqual(Reflect.apply(lastModified.get!, blob, []), 2 ** 52 - 1);
    strictEqual(await Reflect.apply(exists.value, blob, []), true);
    strictEqual(Reflect.apply(name.get!, webFile, []), 'value.txt');
    strictEqual(Reflect.apply(lastModified.get!, webFile, []), 1234);
    strictEqual(await Reflect.apply(exists.value, webFile, []), true);
    Reflect.apply(name.set!, blob, ['renamed.txt']);
    strictEqual(Reflect.apply(name.get!, blob, []), 'renamed.txt');

    for (const receiver of [Object.create(Blob.prototype), new Proxy(blob, {}), {}]) {
        throws(() => Reflect.apply(name.get!, receiver, []), TypeError);
        throws(() => Reflect.apply(lastModified.get!, receiver, []), TypeError);
        throws(() => Reflect.apply(exists.value, receiver, []), TypeError);
    }
});
