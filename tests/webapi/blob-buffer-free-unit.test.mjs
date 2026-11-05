// @cno-host: false
import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { runInNewContext } from 'node:vm';
import { build } from 'esbuild';

const bundled = await build({
    absWorkingDir: fileURLToPath(new URL('../..', import.meta.url)),
    stdin: {
        contents: `
            export { Blob, File, FormData, blobBytesSymbol } from './cno/src/webapi/formdata';
            import './cno/src/webapi/file-reader';
        `,
        resolveDir: fileURLToPath(new URL('../..', import.meta.url)),
        loader: 'ts',
    },
    bundle: true,
    format: 'cjs',
    platform: 'node',
    target: 'es2024',
    define: { 'import.meta.use': '__test_use__' },
    write: false,
    metafile: true,
});

function fixture(platform = 'linux') {
    const allocations = [];
    const encodedStrings = [];
    const base64Inputs = [];
    const modules = {
        os: { platform, getenv: () => null },
        text: { Decoder: TextDecoder },
        asyncfs: {},
        algorithm: {},
        engine: {
            encodeString(input) {
                assert.ok(input.isWellFormed(), 'the native encoder must receive sanitized text');
                encodedStrings.push(input);
                return new TextEncoder().encode(input);
            },
        },
        crypto: {
            base64Encode(input) {
                base64Inputs.push(input);
                return Buffer.from(input).toString('base64');
            },
        },
    };
    const context = {
        module: { exports: {} },
        ArrayBuffer,
        DataView,
        ReadableStream,
        TextDecoder,
        TextEncoder: undefined,
        performance,
        Uint8Array: new Proxy(Uint8Array, {
            construct(target, args) {
                allocations.push(args[0]);
                return Reflect.construct(target, args);
            },
        }),
        __test_use__(name) {
            assert.ok(Object.hasOwn(modules, name), `Unexpected native module: ${name}`);
            return modules[name];
        },
    };
    runInNewContext(bundled.outputFiles[0].text, context);
    return {
        ...context.module.exports,
        FileReader: context.FileReader,
        allocations,
        encodedStrings,
        base64Inputs,
    };
}

test('Blob and FileReader do not pull either Buffer implementation into their bundle', () => {
    const bufferInputs = Object.keys(bundled.metafile.inputs).filter(path =>
        /(?:node-buffer|node_modules\/(?:buffer|base64-js|ieee754)\/|cno\/src\/node\/buffer(?:\/|\.))/.test(path));
    assert.deepEqual(bufferInputs, []);
});

test('Blob encodes strings once without global TextEncoder, preserving UTF-8 and per-part surrogates', async () => {
    const api = fixture();
    assert.equal(api.encodedStrings.length, 0);
    new api.Blob([new Uint8Array([1])]);
    assert.equal(api.encodedStrings.length, 0);

    const parts = ['ASCII\0', '中文', '😀', '\ud83d', '\ude00'];
    let stringifications = 0;
    let value = 'original';
    const blob = new api.Blob([...parts, { toString() { stringifications++; return value; } }]);
    value = 'changed';
    const expected = 'ASCII\0中文😀\ufffd\ufffdoriginal';
    assert.equal(blob.size, Buffer.byteLength(expected));
    assert.equal(await blob.text(), expected);
    assert.deepEqual(await blob.bytes(), new TextEncoder().encode(expected));
    assert.equal(new TextDecoder().decode(await blob.arrayBuffer()), expected);
    assert.deepEqual(api.encodedStrings, [...parts.map(part => part.toWellFormed()), 'original']);
    assert.equal(stringifications, 1);
});

test('Blob snapshots ArrayBuffer and view byte windows before their inputs change', async () => {
    const { Blob } = fixture();
    const viewBacking = new Uint8Array([99, 1, 2, 3, 88]);
    const typed = new Uint8Array([4, 5]);
    const whole = new Uint8Array([6, 7]);
    const blob = new Blob([new DataView(viewBacking.buffer, 1, 3), typed, whole.buffer]);
    viewBacking.fill(0);
    typed.fill(0);
    whole.fill(0);
    assert.equal(blob.size, 7);
    assert.deepEqual(await blob.bytes(), new Uint8Array([1, 2, 3, 4, 5, 6, 7]));
});

test('Blob readers allocate one aggregate and return independently owned bytes', async () => {
    const api = fixture();
    const blob = new api.Blob(['ab', '中']);
    const expected = new TextEncoder().encode('ab中');
    const readers = [
        () => blob.bytes(),
        async () => new Uint8Array(await blob.arrayBuffer()),
        () => blob[api.blobBytesSymbol](),
        async () => (await blob.stream().getReader().read()).value,
    ];
    for (const read of readers) {
        api.allocations.length = 0;
        const result = await read();
        assert.deepEqual(api.allocations, [expected.length], 'no second whole-payload copy');
        assert.deepEqual(result, expected);
        result.fill(0);
    }
    assert.equal(await blob.text(), 'ab中');
    assert.deepEqual(api.encodedStrings, ['ab', '中']);
    assert.equal(await blob.slice(1, -1).text(), 'b\ufffd');
    const empty = new api.Blob().stream().getReader();
    assert.deepEqual(await empty.read(), { value: undefined, done: true });
});

test('nested lazy Blob storage uses its actual payload length and does not leak ownership', async () => {
    const { Blob, blobBytesSymbol } = fixture();
    const source = new Uint8Array([7, 8, 9]);
    let reads = 0;
    class LazyBlob extends Blob {
        get size() { return 0; }
        [blobBytesSymbol]() { reads++; return source; }
    }
    const blob = new Blob([new LazyBlob(), new Blob(['x'])]);
    assert.equal(blob.size, 1, 'size remains based on the lazy Blob metadata');
    assert.equal(reads, 0, 'construction must not materialize lazy Blob bytes');
    const first = await blob.bytes();
    assert.deepEqual(first, new Uint8Array([7, 8, 9, 120]));
    first.fill(0);
    assert.deepEqual(await blob.bytes(), new Uint8Array([7, 8, 9, 120]));
    assert.deepEqual(source, new Uint8Array([7, 8, 9]));
    assert.equal(reads, 2);
});

test('Blob native endings, File metadata, and FormData payloads retain their behavior', async () => {
    for (const [platform, ending] of [['linux', '\n'], ['windows', '\r\n'], ['win32', '\r\n']]) {
        const { Blob, File, FormData } = fixture(platform);
        const blob = new Blob(['a\rb\nc\r\nd'], { endings: 'native', type: 'TEXT/PLAIN' });
        const expected = ['a', 'b', 'c', 'd'].join(ending);
        assert.equal(await blob.text(), expected);
        const file = new File([blob], 'input.txt', { type: blob.type, lastModified: 42 });
        assert.equal(file.lastModified, 42);
        assert.equal(file.size, Buffer.byteLength(expected));
        const form = new FormData();
        form.append('file', file);
        assert.equal(form.get('file'), file);
        form.set('file', blob, 'renamed.txt');
        assert.equal(form.get('file').name, 'renamed.txt');
        assert.equal(form.get('file').type, 'text/plain');
        assert.equal(await form.get('file').text(), expected);
    }
});

function readDataURL(reader, blob) {
    return new Promise((resolve, reject) => {
        reader.onloadend = () => reader.error ? reject(reader.error) : resolve(reader.result);
        reader.readAsDataURL(blob);
    });
}

test('FileReader passes the original ArrayBuffer to native base64 for empty and binary payloads', async () => {
    const api = fixture();
    let returnedBuffer;
    class TrackedBlob extends api.Blob {
        async arrayBuffer() {
            returnedBuffer = await super.arrayBuffer();
            return returnedBuffer;
        }
    }
    for (const values of [[], [0], [0, 255], [0, 255, 127], [0, 255, 127, 1]]) {
        const bytes = new Uint8Array(values);
        for (const type of ['', 'IMAGE/PNG']) {
            const blob = new TrackedBlob([bytes], { type });
            const reader = new api.FileReader();
            const result = await readDataURL(reader, blob);
            assert.equal(result, `data:${type.toLowerCase() || 'application/octet-stream'};base64,${Buffer.from(bytes).toString('base64')}`);
            assert.equal(api.base64Inputs.at(-1), returnedBuffer);
            assert.equal(reader.readyState, reader.DONE);
            assert.equal(reader.error, null);
        }
    }
});

test('FileReader data URL conversion preserves progress events, busy reads, and abort', async () => {
    const { Blob, FileReader } = fixture();
    const reader = new FileReader();
    const events = [];
    for (const name of ['loadstart', 'progress', 'load', 'abort', 'loadend']) {
        reader.addEventListener(name, event => events.push([name, event.loaded, event.total]));
    }
    const read = readDataURL(reader, new Blob(['abc']));
    assert.equal(reader.readyState, reader.LOADING);
    assert.throws(() => reader.readAsDataURL(new Blob()), { name: 'InvalidStateError' });
    assert.equal(await read, 'data:application/octet-stream;base64,YWJj');
    assert.deepEqual(events, [['loadstart', 0, 3], ['progress', 3, 3], ['load', 3, 3], ['loadend', 3, 3]]);

    events.length = 0;
    const aborted = readDataURL(reader, new Blob(['abc']));
    reader.abort();
    assert.equal(await aborted, null);
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(reader.result, null);
    assert.equal(reader.readyState, reader.DONE);
    assert.deepEqual(events, [['loadstart', 0, 3], ['abort', 0, 0], ['loadend', 0, 0]]);
});
