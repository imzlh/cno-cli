// @cno-host: false
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { runInNewContext } from 'node:vm';
import { build } from 'esbuild';

const bundled = await build({
    absWorkingDir: fileURLToPath(new URL('../..', import.meta.url)),
    entryPoints: ['cno/src/webapi/object-url.ts'],
    bundle: true,
    format: 'cjs',
    platform: 'node',
    target: 'es2024',
    write: false,
    metafile: true,
});

function fixture() {
    const context = { module: { exports: {} } };
    runInNewContext(bundled.outputFiles[0].text, context);
    return { api: context.module.exports, context };
}

test('object URL resolver has no runtime import of URL, FormData, or Buffer', () => {
    assert.deepEqual(Object.keys(bundled.metafile.inputs), ['cno/src/webapi/object-url.ts']);
    const { api } = fixture();
    assert.equal(api.resolveObjectURL('blob:/uninitialized'), null);
    assert.equal(api.resolveObjectURLBytes('blob:/uninitialized'), null);
    assert.doesNotThrow(() => api.unregisterObjectURL('not a URL'));
});

test('object URL registry preserves canonical lookup, payload ownership, and revoke semantics', () => {
    const { api } = fixture();
    api.setObjectURLConstructor(URL);
    const source = new Uint8Array([1, 2, 255]);
    let reads = 0;
    const blob = {
        type: 'application/x-test',
        [api.blobBytesSymbol]() {
            assert.equal(this, blob);
            reads++;
            return source.slice();
        },
    };
    const id = api.createObjectUrlId();
    assert.match(id, /^blob:\/cno-/);
    assert.notEqual(api.createObjectUrlId(), id);
    api.registerObjectURL(id, blob);
    assert.equal(reads, 0, 'registration must not materialize Blob bytes');
    assert.equal(api.resolveObjectURL(id), blob);
    assert.equal(api.resolveObjectURL(new URL(id)), blob);
    assert.equal(api.resolveObjectURL(` \t${id}\n`), blob);

    const first = api.resolveObjectURLBytes(id);
    assert.equal(first.type, blob.type);
    assert.deepEqual(first.bytes, source);
    first.bytes[0] = 0;
    assert.deepEqual(api.resolveObjectURLBytes(id).bytes, source);
    assert.equal(reads, 2);
    assert.equal(api.resolveObjectURL(`${id}#fragment`), null);
    assert.equal(api.resolveObjectURL('not a URL'), null);
    assert.equal(api.resolveObjectURL({ toString() { throw new Error('bad input'); } }), null);

    api.unregisterObjectURL(` \t${id}\n`);
    assert.equal(api.resolveObjectURL(id), null);
    assert.equal(api.resolveObjectURLBytes(id), null);
    assert.doesNotThrow(() => api.unregisterObjectURL(id));
    assert.doesNotThrow(() => api.unregisterObjectURL('not a URL'));
});

test('object URL registry keeps its installed parser when the global URL is replaced', () => {
    const { api, context } = fixture();
    api.setObjectURLConstructor(URL);
    const id = api.createObjectUrlId();
    const blob = { type: '', [api.blobBytesSymbol]: () => new Uint8Array([7]) };
    api.registerObjectURL(id, blob);
    context.URL = class {
        constructor() { throw new Error('replacement URL must not be consulted'); }
    };
    assert.equal(api.resolveObjectURL(id), blob);
    assert.deepEqual(api.resolveObjectURLBytes(id).bytes, new Uint8Array([7]));
    api.unregisterObjectURL(id);
    assert.equal(api.resolveObjectURL(id), null);
});
