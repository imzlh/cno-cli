// Run with: node --test tests/cts/evbus-module-bridge-native.test.mjs
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { build } from 'esbuild';

const repository = fileURLToPath(new URL('../../', import.meta.url));
const cno = resolve(process.env.CNO_NATIVE_BIN ?? join(repository, 'build/stage/cno'));

async function bundle(contents, globalName) {
    const stubs = {
        '../types': 'export const moduleEvaluationKey = x => x; export const moduleRef = x => x;',
        '../errors': 'export const isResolutionMiss = () => false; export const requireCycleError = () => {}; export const setErrorCode = () => {};',
        '../resolve/builtins': 'export const builtinModuleNames = () => [];',
        '../runtime-builtin': 'export const canonicalRuntimeBuiltinSpecifier = x => x; export const isRuntimeBuiltinSpecifier = () => false; export const runtimeBuiltinSpecifiers = () => [];',
        '../utils': 'export const errMsg = String; export const log = { warn() {}, debug() {} };',
        '../module-hooks': 'export const hasModuleLoadHooks = () => false; export const hasModuleResolveHooks = () => false; export const registerModuleHooks = () => {}; export const runModuleLoadHooks = () => {}; export const runModuleResolveHooks = () => {};',
    };
    const result = await build({
        absWorkingDir: repository,
        bundle: true,
        format: 'iife',
        globalName,
        platform: 'neutral',
        target: 'es2024',
        write: false,
        define: { 'import.meta.use': '__test_use__' },
        plugins: [{
            name: 'isolate-bridge-dependencies',
            setup(build) {
                build.onResolve({ filter: /^\.\.\// }, args => {
                    if (args.importer.endsWith('/cts/src/compile/bridge.ts') && args.path in stubs) {
                        return { path: args.path, namespace: 'bridge-test-stub' };
                    }
                });
                build.onLoad({ filter: /.*/, namespace: 'bridge-test-stub' }, args => ({
                    contents: stubs[args.path],
                }));
            },
        }],
        stdin: { contents, resolveDir: repository },
    });
    assert.deepEqual(result.outputFiles.length, 1);
    return result.outputFiles[0].text;
}

test('native evbus bridge: real sandbox realms, ownership, GC and legacy slots', {
    skip: !existsSync(cno) && `native binary not found: ${cno}`,
    timeout: 60_000,
}, async () => {
    const [ctsSource, cnoSource] = await Promise.all([
        bundle(`
            export { installInternalBridge } from './cts/src/compile/bridge.ts';
            export { getInternalBridge } from './cts/src/compile/internal-registry.ts';
            export { getNodeModuleInterop } from './cts/src/compile/node-interop.ts';
        `, '__ctsBridge'),
        bundle(`
            export { getCtsBridge, registerNodeModuleInterop } from './cno/src/node/_internal/cts-bridge.ts';
        `, '__cnoBridge'),
    ]);

    // Sandbox.loadModule does not inject import.meta.use. Supplying its native
    // use function as a sandbox global still exercises the real evbus and App.
    const script = `
const __test_use__ = import.meta.use;
const engine = __test_use__('engine');
const bus = __test_use__('evbus');
if (!bus) throw new Error('native binary has no evbus; rebuild it first');
const namespace = 'cts.internal';
const key = 'bridge';
const saved = bus.get(namespace, key);
const hadSaved = bus.has(namespace, key);
const ctsSource = ${JSON.stringify(ctsSource)};
const cnoSource = ${JSON.stringify(cnoSource)};
${ctsSource}
function assert(value, message) { if (!value) throw new Error(message); }
function sandbox() {
    const realm = new engine.Sandbox();
    realm.global.__test_use__ = __test_use__;
    return realm;
}
function install(cts, label) {
    const cache = new Map();
    cts.installInternalBridge(() => () => label, () => undefined, cache,
        { getInfo: spec => ({ localPath: '/local/' + spec }) }, {
            replaceCache() {}, resetCache() {}, replaceExtensions() {}, resetExtensions() {},
        });
}
try {
    // Initial registration in a long-lived realm must not be transferred to a
    // second, short-lived realm when that realm reinstalls CTS.
    bus.delete(namespace, key);
    let owner = sandbox();
    owner.call(ctsSource);
    install(owner.global.__ctsBridge, 'owner');
    const ownedBridge = bus.get(namespace, key);
    const ownedInterop = ownedBridge.nodeModuleInterop;
    assert(owner.global.__ctsBridge.getInternalBridge() === ownedBridge, 'owner bridge identity');

    let observer = sandbox();
    observer.call("Object.defineProperty(globalThis, Symbol.for('cts.internal'), {value: 'sentinel', configurable: false})");
    observer.call(cnoSource);
    observer.call('__cnoBridge.registerNodeModuleInterop(() => {})');
    assert(observer.global.__cnoBridge.getCtsBridge() === ownedBridge, 'CNO sandbox sees owner bridge');
    observer.call(ctsSource);
    install(observer.global.__ctsBridge, 'observer');
    assert(observer.global.__ctsBridge.getInternalBridge() === ownedBridge, 'sandbox reinstall identity');
    assert(observer.global.__ctsBridge.getNodeModuleInterop() === ownedInterop, 'sandbox interop identity');
    assert(observer.call("globalThis[Symbol.for('cts.internal')]") === 'sentinel', 'non-configurable slot preserved');
    observer = null;
    engine.gc.run();
    assert(bus.get(namespace, key) === ownedBridge, 'sandbox reinstall transferred ownership');
    assert(__ctsBridge.getInternalBridge() === ownedBridge, 'main cached evbus sees sandbox bridge');
    owner = null;
    engine.gc.run();
    assert(!bus.has(namespace, key), 'owner sandbox cleanup must remove its entry');

    // A sandbox which loads CNO before CTS must not create a bridge it owns.
    const seen = { count: 0 };
    let abandoned = sandbox();
    abandoned.global.__seen = seen;
    abandoned.call(cnoSource);
    abandoned.call('__cnoBridge.registerNodeModuleInterop(() => { __seen.count++ })');
    abandoned = null;
    engine.gc.run();
    assert(!bus.has(namespace, key), 'CNO-only sandbox created a shared bridge');

    let early = sandbox();
    early.call(cnoSource);
    early.call('__cnoBridge.registerNodeModuleInterop(interop => { interop.getCache = () => __cnoBridge.getCtsBridge() })');
    assert(!bus.has(namespace, key), 'CNO-before-CTS must wait without owning a bridge');
    install(__ctsBridge, 'main');
    const pending = bus.get(namespace, key);
    const pendingInterop = pending.nodeModuleInterop;
    assert(seen.count === 0, 'collected sandbox received a bridge-ready event');
    assert(__ctsBridge.getInternalBridge() === pending, 'main must own the bridge');
    assert(early.global.__cnoBridge.getCtsBridge() === pending, 'early CNO bridge identity');
    assert(pendingInterop.getCache() === pending, 'early CNO did not register its interop');
    early = null;
    engine.gc.run();
    assert(bus.get(namespace, key) === pending, 'sandbox cleanup removed main-owned bridge');
    assert(__ctsBridge.getNodeModuleInterop() === pendingInterop, 'interop changed after sandbox GC');
    assert(pendingInterop.getCache() === pending, 'sandbox interop cannot read bridge after GC');
    console.log('native evbus module bridge: ok');
} finally {
    bus.delete(namespace, key);
    if (hadSaved) bus.set(namespace, key, saved);
}
`;

    const tmp = mkdtempSync(join(tmpdir(), 'cno-evbus-bridge-'));
    try {
        const entry = join(tmp, 'bridge.mjs');
        writeFileSync(entry, script);
        const child = spawnSync(cno, ['run', '--no-lock', '--no-http', '--no-jsr', '--no-node', entry], {
            cwd: tmp,
            env: { ...process.env, CTS_CACHE_DIR: join(tmp, 'cache') },
            encoding: 'utf8',
            timeout: 45_000,
            maxBuffer: 4 * 1024 * 1024,
        });
        assert.equal(child.error, undefined, child.error?.message);
        assert.equal(child.status, 0, `native child failed (${child.signal ?? 'no signal'}):\n${child.stdout}\n${child.stderr}`);
        assert.match(child.stdout, /native evbus module bridge: ok/);
    } finally {
        rmSync(tmp, { recursive: true, force: true });
    }
});
