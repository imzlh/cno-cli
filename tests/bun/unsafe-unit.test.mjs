// @cno-host: false
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { runInNewContext } from 'node:vm';

const result = await build({
    absWorkingDir: fileURLToPath(new URL('../..', import.meta.url)),
    entryPoints: ['cno/src/bun/utils/unsafe.ts'],
    bundle: true,
    format: 'esm',
    platform: 'node',
    target: 'es2024',
    write: false,
    define: { 'import.meta.use': 'globalThis.__bunUnsafeUse' },
});
const source = `data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString('base64')}`;
let moduleNumber = 0;

async function load(
    platform,
    readFile,
    decodeString = bytes => new TextDecoder().decode(bytes),
    decodeU16String = bytes => String.fromCharCode(...bytes),
) {
    let gcRuns = 0;
    globalThis.__bunUnsafeUse = name => {
        if (name === 'os') return { platform };
        if (name === 'fs') return { readFile };
        if (name === 'engine') return {
            decodeString,
            decodeU16String,
            gc: { run() { gcRuns++; } },
        };
        if (name === 'algorithm') return {
            latin1DecodeLoose: value => String.fromCharCode(...value),
        };
        throw new Error(`unexpected native module: ${name}`);
    };
    const module = await import(`${source}#${moduleNumber++}`);
    return { ...module, get gcRuns() { return gcRuns; } };
}

function bytes(text) {
    return new TextEncoder().encode(text).buffer;
}

test('unsafe.memoryFootprint reads the single Linux Pss value in bytes', async () => {
    const { unsafe } = await load('linux', path => {
        assert.equal(path, '/proc/self/smaps_rollup');
        return bytes('rollup\nPss:               1234 kB\nPrivate_Clean: 0 kB\n');
    });
    assert.equal(unsafe.memoryFootprint(), 1234 * 1024);
    assert.equal(Object.isFrozen(unsafe), true);
});

test('unsafe.memoryFootprint does not access procfs on other platforms', async () => {
    const { unsafe } = await load('darwin', () => {
        throw new Error('must not read');
    });
    assert.equal(unsafe.memoryFootprint(), undefined);
});

test('unsafe.memoryFootprint rejects malformed, ambiguous, and overflowing Pss values', async () => {
    for (const report of [
        'Rss: 8 kB\n',
        'Pss: invalid kB\n',
        'Pss: 4 KB\n',
        'Pss: 4 kB trailing\n',
        'Pss: 4 kB\nPss: 5 kB\n',
        `Pss: ${String(Number.MAX_SAFE_INTEGER)} kB\n`,
    ]) {
        const { unsafe } = await load('linux', () => bytes(report));
        assert.equal(unsafe.memoryFootprint(), undefined, report);
    }
});

test('unsafe.memoryFootprint treats unavailable procfs and decode failures as unavailable', async () => {
    let mod = await load('linux', () => { throw new Error('ENOENT'); });
    assert.equal(mod.unsafe.memoryFootprint(), undefined);

    mod = await load('linux', () => bytes('Pss: 1 kB\n'), () => { throw new Error('bad bytes'); });
    assert.equal(mod.unsafe.memoryFootprint(), undefined);
});

test('unsafe.arrayBufferToString decodes ASCII views and UTF-16 views', async () => {
    const { unsafe } = await load('linux', () => bytes('Pss: 1 kB\n'));
    assert.equal(unsafe.arrayBufferToString(new Uint8Array([65, 66, 67])), 'ABC');
    assert.equal(unsafe.arrayBufferToString(new Uint8Array(new Uint8Array([0, 65, 0, 66]).buffer)), '\u0000A\u0000B');
    assert.equal(unsafe.arrayBufferToString(new Uint16Array([0x0041, 0x03a9])), 'A\u03a9');
    assert.equal(unsafe.arrayBufferToString(new Int16Array([-1, 0x0041])), '\uffffA');
    assert.equal(unsafe.arrayBufferToString(new Uint8Array([66, 67]).buffer), 'BC');
    assert.equal(unsafe.arrayBufferToString(new Uint8Array([65, 255])), 'A\u00ff');
    assert.equal(unsafe.arrayBufferToString(new Int8Array([-1, 65])), '\u00ffA');
});

test('unsafe.arrayBufferToString uses intrinsic slots across realms', async () => {
    const { unsafe } = await load('linux', () => bytes('Pss: 1 kB\n'));
    const foreign = runInNewContext(`(() => {
        const arrayBuffer = new Uint8Array([65, 66]).buffer;
        const uint8 = new Uint8Array([67, 68]);
        const uint16 = new Uint16Array([0x0041, 0x03a9]);
        for (const value of [arrayBuffer, uint8, uint16]) {
            for (const key of ['buffer', 'byteOffset', 'byteLength', Symbol.toStringTag]) {
                Object.defineProperty(value, key, {
                    configurable: true,
                    get() { throw new Error('shadowed ' + String(key)); },
                });
            }
        }
        const result = { arrayBuffer, uint8, uint16 };
        if (typeof SharedArrayBuffer === 'function') {
            const shared = new SharedArrayBuffer(2);
            new Uint8Array(shared).set([69, 70]);
            Object.defineProperty(shared, 'byteLength', {
                get() { throw new Error('shadowed byteLength'); },
            });
            result.shared = shared;
        }
        return result;
    })()`);

    assert.equal(foreign.arrayBuffer instanceof ArrayBuffer, false);
    assert.equal(foreign.uint8 instanceof Uint8Array, false);
    assert.equal(unsafe.arrayBufferToString(foreign.arrayBuffer), 'AB');
    assert.equal(unsafe.arrayBufferToString(foreign.uint8), 'CD');
    assert.equal(unsafe.arrayBufferToString(foreign.uint16), 'A\u03a9');
    if (foreign.shared) assert.equal(unsafe.arrayBufferToString(foreign.shared), 'EF');
});

test('unsafe.arrayBufferToString treats detached and out-of-bounds slots as empty', async () => {
    const { unsafe } = await load('linux', () => bytes('Pss: 1 kB\n'));
    for (const make of [
        buffer => buffer,
        buffer => new Uint8Array(buffer),
        buffer => new Uint16Array(buffer),
        buffer => new Int16Array(buffer),
    ]) {
        const buffer = new ArrayBuffer(4);
        const value = make(buffer);
        structuredClone(buffer, { transfer: [buffer] });
        assert.equal(unsafe.arrayBufferToString(value), '');
    }

    if (typeof ArrayBuffer.prototype.resize === 'function') {
        const buffer = new ArrayBuffer(4, { maxByteLength: 8 });
        const uint8 = new Uint8Array(buffer, 2, 2);
        const uint16 = new Uint16Array(buffer, 2, 1);
        buffer.resize(1);
        assert.equal(unsafe.arrayBufferToString(uint8), '');
        assert.equal(unsafe.arrayBufferToString(uint16), '');
    }
});

test('unsafe.arrayBufferToString rejects unsupported inputs with Bun coded errors', async () => {
    const { unsafe } = await load('linux', () => bytes('Pss: 1 kB\n'));
    let traps = 0;
    const proxy = new Proxy(new Uint8Array([65]), {
        get() { traps++; throw new Error('proxy get'); },
        getPrototypeOf() { traps++; throw new Error('proxy getPrototypeOf'); },
    });
    const errors = [undefined, null, [65, 66], new DataView(new ArrayBuffer(2)), proxy].map(value => {
        try {
            unsafe.arrayBufferToString(value);
        } catch (error) {
            return error;
        }
        assert.fail(`accepted ${String(value)}`);
    });

    const prototype = Object.getPrototypeOf(errors[0]);
    for (const error of errors) {
        assert.equal(error instanceof TypeError, true);
        assert.equal(error.name, 'TypeError');
        assert.equal(error.message, 'Expected an ArrayBuffer');
        assert.equal(error.code, 'ERR_INVALID_ARG_TYPE');
        assert.equal(Object.hasOwn(error, 'code'), false);
        assert.equal(Object.getPrototypeOf(error), prototype);
        assert.equal(String(error), 'TypeError [ERR_INVALID_ARG_TYPE]: Expected an ArrayBuffer');
        assert.equal(Error.prototype.toString.call(error), 'TypeError: Expected an ArrayBuffer');
        assert.deepEqual(Object.keys(error), []);
        assert.equal(JSON.stringify(error), '{}');
    }
    assert.equal(traps, 0);
    assert.notEqual(prototype, TypeError.prototype);
    assert.equal(Object.getPrototypeOf(prototype), TypeError.prototype);
    assert.deepEqual(Object.getOwnPropertyDescriptor(prototype, 'name'), {
        configurable: true, enumerable: true, value: 'TypeError', writable: true,
    });
    assert.deepEqual(Object.getOwnPropertyDescriptor(prototype, 'code'), {
        configurable: true, enumerable: true, value: 'ERR_INVALID_ARG_TYPE', writable: true,
    });
    assert.deepEqual(Object.getOwnPropertyDescriptor(prototype, 'toString'), {
        configurable: true, enumerable: true, value: prototype.toString, writable: true,
    });
    assert.equal(prototype.toString.name, 'toString');
    assert.equal(prototype.toString.length, 0);
    assert.equal(Object.hasOwn(prototype.toString, 'prototype'), false);

    const spoofed = new Uint8Array([65, 66]);
    Object.defineProperty(spoofed, Symbol.toStringTag, { value: 'Uint16Array' });
    assert.equal(unsafe.arrayBufferToString(spoofed), 'AB');
});

test('unsafe helpers have Bun function shapes', async () => {
    const mod = await load('linux', () => bytes('Pss: 1 kB\n'));
    for (const [fn, name, length] of [
        [mod.unsafe.arrayBufferToString, 'arrayBufferToString', 1],
        [mod.unsafe.memoryFootprint, 'memoryFootprint', 0],
        [mod.shrink, 'shrink', 0],
    ]) {
        assert.equal(fn.name, name);
        assert.equal(fn.length, length);
        assert.equal(Object.hasOwn(fn, 'prototype'), false);
        assert.throws(() => Reflect.construct(fn, []), TypeError);
    }
});

test('unsafe.shrink requests one best-effort engine collection', async () => {
    const mod = await load('linux', () => bytes('Pss: 1 kB\n'));
    mod.shrink();
    assert.equal(mod.gcRuns, 1);
});
