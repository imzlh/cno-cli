// @cno-host: false
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

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
    assert.equal(unsafe.arrayBufferToString(new Uint8Array([66, 67]).buffer), 'BC');
});

test('unsafe.arrayBufferToString rejects non-ASCII and unsupported inputs', async () => {
    const { unsafe } = await load('linux', () => bytes('Pss: 1 kB\n'));
    assert.throws(() => unsafe.arrayBufferToString(new Uint8Array([0xc3, 0xa9])), /ASCII/);
    assert.throws(() => unsafe.arrayBufferToString([65, 66]), TypeError);
    assert.throws(() => unsafe.arrayBufferToString(new DataView(new ArrayBuffer(2))), TypeError);
    const spoofed = new Uint8Array([65, 66]);
    Object.defineProperty(spoofed, Symbol.toStringTag, { value: 'Uint16Array' });
    assert.equal(unsafe.arrayBufferToString(spoofed), 'AB');
});

test('unsafe.shrink requests one best-effort engine collection', async () => {
    const mod = await load('linux', () => bytes('Pss: 1 kB\n'));
    mod.shrink();
    assert.equal(mod.gcRuns, 1);
});
