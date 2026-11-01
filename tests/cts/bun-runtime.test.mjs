// Run with: node --test tests/cts/bun-runtime.test.mjs
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { runInNewContext } from 'node:vm';
import test from 'node:test';
import { build } from 'esbuild';

const repository = fileURLToPath(new URL('../../', import.meta.url));

const bundle = await build({
    absWorkingDir: repository,
    bundle: true,
    format: 'cjs',
    platform: 'node',
    target: 'es2024',
    write: false,
    define: { 'import.meta.use': '__test_use__', 'import.meta.register': 'undefined' },
    stdin: {
        contents: `
            export { resolveBunDir, bunDirCandidates } from './src/bun-runtime.ts';
            export { flagsToConfig, publishWorkerRuntimeConfig, decodeWorkerRuntimeConfig } from './src/config.ts';
        `,
        resolveDir: repository,
    },
});

/** Load the module against an in-memory file system and environment. */
function load({ exe, files = [], env = {}, cwd = '/work' }) {
    const stats = [];
    const present = new Set(files);
    const values = new Map();
    const bus = {
        get: (namespace, key) => values.get(`${namespace}:${key}`),
        set: (namespace, key, value) => values.set(`${namespace}:${key}`, value),
    };
    const native = {
        os: {
            exePath: exe,
            cwd,
            uname: () => ({ sysname: 'Linux' }),
            getenv: name => env[name],
            args: [],
            platform: 'linux',
            homeDir: '/home/test',
            pid: 1,
            STDERR_FILENO: 2,
            guessHandle: () => 'file',
            memoryUsage: () => ({ 'os.total': 1024 ** 3 }),
        },
        fs: {
            stat(path) {
                stats.push(path);
                if (!present.has(path)) throw new Error(`ENOENT: ${path}`);
                return { isFile: true, isDirectory: false };
            },
        },
        engine: {},
        error: { errno: {} },
        evbus: bus,
        asyncfs: {},
        nodeapi: {},
        worker: {},
        crypto: {},
        zlib: {},
        console,
        timers: { setTimeout, clearTimeout, setInterval, clearInterval },
    };
    const module = { exports: {} };
    const context = { module, exports: module.exports, __test_use__: name => native[name], console, Buffer, process, TextDecoder, TextEncoder, URL, URLSearchParams, setTimeout, clearTimeout, setInterval, clearInterval };
    runInNewContext(bundle.outputFiles[0].text, context);
    return { api: module.exports, stats, context, bus };
}

const payload = dir => [`${dir}/index.js`, `${dir}/sqlite.js`];

test('CNO_BUN_DIR is authoritative even when missing, and is made absolute', () => {
    const { api, stats } = load({
        exe: '/opt/cno/bin/cno',
        files: payload('/opt/cno/bin/lib/cno/bun'),
        env: { CNO_BUN_DIR: 'relative/bun' },
    });
    assert.equal(api.resolveBunDir(), '/work/relative/bun');
    assert.deepEqual(stats, []);
});

test('staged executable directory wins over installed layouts', () => {
    const { api } = load({
        exe: '/opt/cno/bin/cno',
        files: [...payload('/opt/cno/bin/lib/cno/bun'), ...payload('/opt/cno/lib/cno/bun')],
    });
    assert.equal(api.resolveBunDir(), '/opt/cno/bin/lib/cno/bun');
});

test('installed lib and lib64 payloads are found, in that order', () => {
    const lib64 = load({ exe: '/usr/bin/cno', files: payload('/usr/lib64/cno/bun') });
    assert.equal(lib64.api.resolveBunDir(), '/usr/lib64/cno/bun');
    const both = load({
        exe: '/usr/bin/cno',
        files: [...payload('/usr/lib64/cno/bun'), ...payload('/usr/lib/cno/bun')],
    });
    assert.equal(both.api.resolveBunDir(), '/usr/lib/cno/bun');
});

test('an incomplete payload directory is skipped', () => {
    const { api } = load({
        exe: '/usr/bin/cno',
        files: ['/usr/lib/cno/bun/index.js', ...payload('/usr/lib64/cno/bun')],
    });
    assert.equal(api.resolveBunDir(), '/usr/lib64/cno/bun');
});

test('generated dist is used only from a CMake build tree', () => {
    const dist = payload('/repo/dist/lib/cno/bun');
    const stage = load({ exe: '/repo/build/stage/cno', files: ['/repo/build/CMakeCache.txt', ...dist] });
    assert.equal(stage.api.resolveBunDir(), '/repo/dist/lib/cno/bun');
    const direct = load({ exe: '/repo/build/cno', files: ['/repo/build/CMakeCache.txt', ...dist] });
    assert.equal(direct.api.resolveBunDir(), '/repo/dist/lib/cno/bun');
    // Without a build tree marker, a sibling dist directory is not trusted.
    const installed = load({ exe: '/repo/build/stage/cno', files: dist });
    assert.equal(installed.api.resolveBunDir(), undefined);
});

test('discovery never selects Bun sources, caches, or reads payload contents', () => {
    const { api, stats } = load({
        exe: '/repo/build/stage/cno',
        files: [
            ...payload('/repo/cno/src/bun'),
            ...payload('/home/user/.cache/cts/bun'),
            ...payload('/repo/build/bun'),
        ],
    });
    assert.equal(api.resolveBunDir(), undefined);
    // Only stat is mocked, so any read or import of a payload would have thrown.
    assert.ok(stats.every(path => !path.includes('/cno/src/bun') && !path.includes('.cache')));
});

test('missing executable path disables discovery without throwing', () => {
    assert.equal(load({ exe: '' }).api.resolveBunDir(), undefined);
});

test('bunDir crosses into the worker runtime config', () => {
    const { api, bus } = load({ exe: '/usr/bin/cno' });
    api.publishWorkerRuntimeConfig({ bunDir: '/usr/lib/cno/bun', cacheDir: '/c' });
    const published = bus.get('cno.runtime', 'workerRuntimeConfig');
    assert.equal(published.bunDir, '/usr/lib/cno/bun');
    assert.equal(api.decodeWorkerRuntimeConfig(published).bunDir, '/usr/lib/cno/bun');
    api.publishWorkerRuntimeConfig({});
    assert.equal(bus.get('cno.runtime', 'workerRuntimeConfig').bunDir, undefined);
});
