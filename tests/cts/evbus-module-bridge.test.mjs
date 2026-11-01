// @cno-host: false
// Run with: node --test tests/cts/evbus-module-bridge.test.mjs
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { createContext, runInContext } from 'node:vm';
import test from 'node:test';
import { build } from 'esbuild';

const repository = fileURLToPath(new URL('../../', import.meta.url));
const legacySlot = Symbol.for('cts.internal');

async function bundle(contents) {
    const result = await build({
        absWorkingDir: repository,
        bundle: true,
        format: 'cjs',
        platform: 'node',
        target: 'es2024',
        write: false,
        define: { 'import.meta.use': '__test_use__' },
        stdin: { contents, resolveDir: repository },
    });
    return result.outputFiles[0].text;
}

const [ctsSource, cnoSource] = await Promise.all([
    bundle(`
        export { installInternalBridge } from './cts/src/compile/bridge.ts';
        export { getInternalBridge } from './cts/src/compile/internal-registry.ts';
        export { getNodeModuleInterop } from './cts/src/compile/node-interop.ts';
    `),
    bundle(`
        export * as module from './cno/src/node/module/mod.ts';
        export { fileURLToPath } from './cno/src/node/url/mod.ts';
        export { getCtsBridge } from './cno/src/node/_internal/cts-bridge.ts';
    `),
]);

function makeBus() {
    const values = new Map();
    const listeners = new Map();
    return {
        writes: 0,
        get(namespace, key) { return values.get(`${namespace}:${key}`); },
        set(namespace, key, value) {
            this.writes++;
            values.set(`${namespace}:${key}`, value);
        },
        on(namespace, event, listener) {
            const key = `${namespace}:${event}`;
            const group = listeners.get(key) ?? new Set();
            listeners.set(key, group);
            group.add(listener);
            return () => group.delete(listener);
        },
        emit(namespace, event, value) {
            const group = listeners.get(`${namespace}:${event}`);
            for (const listener of [...(group ?? [])]) listener(value);
            return Boolean(group?.size);
        },
    };
}

function makeContext(evbus) {
    const native = {
        evbus,
        engine: {
            decodeString: value => new TextDecoder().decode(value),
            encodeString: value => new TextEncoder().encode(value),
        },
        fs: { exists: () => false },
        os: {
            args: [], cwd: repository, homeDir: repository,
            memoryUsage: () => ({ 'os.total': 1024 ** 3 }),
            platform: process.platform, pid: process.pid,
            STDERR_FILENO: 2, guessHandle: () => 'file',
            getenv: () => undefined,
            uname: () => ({ sysname: process.platform === 'win32' ? 'Windows_NT' : 'Linux' }),
        },
        console,
        timers: { setTimeout, clearTimeout, setInterval, clearInterval },
    };
    return createContext({
        __test_use__: name => {
            if (name === 'evbus' && evbus instanceof Error) throw evbus;
            return native[name];
        },
        Buffer, console, process, TextDecoder, TextEncoder, URL, URLSearchParams,
        setTimeout, clearTimeout, setInterval, clearInterval,
    });
}

function load(context, source) {
    context.module = { exports: {} };
    context.exports = context.module.exports;
    runInContext(source, context);
    return context.module.exports;
}

function install(cts, options = {}) {
    const calls = [];
    const cache = new Map();
    const require = Object.assign(() => options.marker, { resolve: id => id });
    cts.installInternalBridge(
        () => require,
        () => undefined,
        cache,
        { getInfo: spec => ({ localPath: `/local/${spec}` }) },
        {
            replaceCache: value => calls.push(['replaceCache', value]),
            resetCache: value => calls.push(['resetCache', value]),
            replaceExtensions: value => calls.push(['replaceExtensions', value]),
            resetExtensions: () => calls.push(['resetExtensions']),
        },
    );
    return { cache, calls, require };
}

test('evbus bridge: CTS and CNO share identity across isolated globals and reinstalls', () => {
    const bus = makeBus();
    const main = makeContext(bus);
    const sandbox = makeContext(bus);
    const cts = load(main, ctsSource);
    const initial = install(cts, { marker: 'first' });
    const bridge = cts.getInternalBridge();
    const node = load(sandbox, cnoSource);

    assert.equal(bus.writes, 1);
    assert.equal(node.getCtsBridge(), bridge);
    assert.equal(cts.getNodeModuleInterop(), bridge.nodeModuleInterop);
    assert.equal(bridge.nodeModuleInterop.getCache(), node.module.Module._cache);
    assert.equal(bridge.nodeModuleInterop.getExtensions(), node.module.Module._extensions);
    assert.equal(node.fileURLToPath('npm:example@1/index.js'), '/local/npm:example@1/index.js');
    assert.equal(sandbox[legacySlot], undefined, 'discovery never needs a global slot');
    assert.equal(globalThis[legacySlot], undefined, 'the legacy slot stays unwritten');

    const replacementCache = { existing: 1 };
    node.module.Module._cache = replacementCache;
    assert.ok(initial.calls.some(([name, value]) => name === 'replaceCache' && value === replacementCache));

    const reinstalled = install(cts, { marker: 'second' });
    assert.equal(cts.getInternalBridge(), bridge);
    assert.equal(cts.getNodeModuleInterop(), bridge.nodeModuleInterop);
    assert.equal(bridge.mkRequire('/entry')(), 'second');
    assert.ok(reinstalled.calls.some(([name, value]) => name === 'replaceCache' && value === replacementCache));
    assert.equal(bus.writes, 1, 'reinstallation must not transfer native entry ownership');

    const otherCts = load(sandbox, ctsSource);
    install(otherCts, { marker: 'sandbox' });
    assert.equal(otherCts.getInternalBridge(), bridge);
    assert.equal(bus.get('cts.internal', 'bridge'), bridge, 'the bus entry stays the shared identity');
    assert.equal(bus.writes, 1, 'sandbox installs must not take ownership of the shared entry');
});

test('evbus bridge: CNO waits for CTS before creating the shared bridge', () => {
    const bus = makeBus();
    const cnoContext = makeContext(bus);
    const ctsContext = makeContext(bus);
    const node = load(cnoContext, cnoSource);
    assert.equal(node.getCtsBridge(), undefined);
    assert.equal(bus.writes, 0, 'CNO must not make its realm the bridge owner');
    assert.equal(cnoContext[legacySlot], undefined);

    const cts = load(ctsContext, ctsSource);
    const installed = install(cts);
    const bridge = cts.getInternalBridge();
    const interop = bridge.nodeModuleInterop;
    assert.equal(node.getCtsBridge(), bridge);
    assert.equal(typeof interop.getCache, 'function');
    assert.equal(cts.getNodeModuleInterop(), interop);
    assert.ok(installed.calls.some(([name]) => name === 'resetCache'));
    assert.ok(installed.calls.some(([name]) => name === 'resetExtensions'));
    assert.equal(node.module.isBuiltin('fs'), true);
    assert.equal(node.fileURLToPath('npm:example@1/index.js'), '/local/npm:example@1/index.js');
    assert.equal(bus.writes, 1);
});

for (const absentBus of [null, new Error('old runtime')]) {
    test(`evbus bridge: an absent bus degrades to a realm-local bridge (${absentBus === null ? 'missing' : 'throws'})`, () => {
        const context = makeContext(absentBus);
        const cts = load(context, ctsSource);
        install(cts);
        const bridge = cts.getInternalBridge();
        assert.equal(bridge, cts.getInternalBridge(), 'realm-local bridge identity is stable');
        const node = load(context, cnoSource);
        assert.equal(node.getCtsBridge(), undefined, 'CNO cannot discover a bridge without a bus');
        assert.equal(node.fileURLToPath('npm:example@1/index.js'), 'npm:example@1/index.js');
        assert.equal(Object.getOwnPropertyDescriptor(context, legacySlot), undefined);
    });
}

test('evbus bridge: preserve unrelated non-configurable legacy slots', () => {
    const bus = makeBus();
    const context = makeContext(bus);
    const sentinel = 'do not replace';
    Object.defineProperty(context, legacySlot, { value: sentinel, configurable: false });
    const cts = load(context, ctsSource);
    install(cts);
    const node = load(context, cnoSource);
    assert.equal(context[legacySlot], sentinel, 'neither side writes the legacy slot');
    assert.equal(node.getCtsBridge(), cts.getInternalBridge());
    assert.equal(node.fileURLToPath('npm:example@1/index.js'), '/local/npm:example@1/index.js');
});

test('evbus bridge: a pre-existing legacy object is ignored in favour of the bus', () => {
    const bus = makeBus();
    const context = makeContext(bus);
    const interop = {};
    const legacy = { nodeModuleInterop: interop };
    Object.defineProperty(context, legacySlot, { value: legacy, configurable: false });
    const cts = load(context, ctsSource);
    install(cts);
    assert.equal(bus.get('cts.internal', 'bridge'), cts.getInternalBridge());
    assert.notEqual(cts.getInternalBridge(), legacy);
});
