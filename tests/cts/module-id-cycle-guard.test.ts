// CJS/ESM cycle guard under a non-default moduleRef.
//
// A ModuleInfo with a moduleId (text/bytes/json attribute views, and every
// pack: view) is compiled and evaluated under moduleRef(info) = moduleId, not
// under info.localPath. The guard that refuses require() of a mid-evaluation
// ESM module must therefore be checked under the SAME key: when it keyed on
// localPath it never fired for such a view and QuickJS reached
// js_link_module with a JS_MODULE_STATUS_EVALUATING module — an abort, not a
// throwable error.
import { ok, strictEqual } from 'node:assert';
import { join } from 'node:path';
import { EsmCompiler } from '../../cts/src/compile/esm.ts';
import { loadEsmSync } from '../../cts/src/compile/bridge.ts';
import { createConfig } from '../../cts/src/config.ts';
import { err, ErrorKind, isResolutionMiss } from '../../cts/src/errors.ts';
import { moduleViewRef, type ModuleInfo } from '../../cts/src/types.ts';
import { makePosixTempDir } from '../_helpers/temp.ts';

function config(root: string) {
    return createConfig({
        cacheDir: join(root, '.cache'),
        disableLock: true,
        enableCache: false,
        silent: true,
        enableNode: false,
    });
}

/** A view (moduleId) and its base file share localPath; only the key differs. */
function viewInfo(localPath: string, fileKind: 'json' | 'text'): ModuleInfo {
    return {
        specPath: localPath,
        localPath,
        format: 'esm',
        fileKind,
        moduleId: moduleViewRef(localPath, fileKind),
        cacheBytecode: false,
    };
}

function cycleMessage(e: unknown): string {
    return String((e as Error)?.message ?? e);
}

Deno.test('cts esm: isInFlight uses the same key load()/trackEvaluation use', () => {
    const dir = makePosixTempDir('moduleid-cycle-unit');
    const root = `${dir}/self.json`;
    Deno.writeFileSync(root, new TextEncoder().encode('{"a":1}'));
    const cfg = config(dir);
    const esm = new EsmCompiler(cfg);
    const info = viewInfo(root, 'json');
    try {
        // Wrong key (localPath) — what the guard used to check.
        ok(!esm.isInFlight(info.localPath), 'a moduleId view is not tracked under localPath');
        esm.trackEvaluation(moduleViewRef(root, 'json'), () => {
            ok(esm.isInFlight(moduleViewRef(root, 'json')), 'tracked under moduleRef');
        });
        ok(!esm.isInFlight(moduleViewRef(root, 'json')), 'window closed after evaluation');
    } finally {
        esm.clearLoadedModules();
    }
});

Deno.test('cts bridge: require() of a mid-evaluation view is refused, not re-linked', () => {
    const dir = makePosixTempDir('moduleid-cycle-bridge');
    const root = `${dir}/self.json`;
    Deno.writeFileSync(root, new TextEncoder().encode('{"a":1}'));
    const cfg = config(dir);
    const esm = new EsmCompiler(cfg);
    const info = viewInfo(root, 'json');
    const ref = moduleViewRef(root, 'json');
    try {
        let thrown: unknown;
        esm.trackEvaluation(ref, () => {
            try {
                loadEsmSync(info, esm, undefined, root);
            } catch (e) {
                thrown = e;
            }
        });
        ok(thrown instanceof Error, `require() of the in-flight view must throw, got ${String(thrown)}`);
        strictEqual(Reflect.get(thrown, 'code'), 'ERR_REQUIRE_CYCLE_MODULE', cycleMessage(thrown));
        ok(cycleMessage(thrown).includes(ref), `cycle error must name the moduleId, got: ${cycleMessage(thrown)}`);
        // The refusal happened before evaluation: the placeholder stayed empty.
        ok(!esm.isInFlight(ref));

        // Once the window closes the same view loads normally.
        const ns = loadEsmSync(info, esm, undefined, root);
        strictEqual(ns.default.a, 1);
    } finally {
        esm.clearLoadedModules();
    }
});

Deno.test('cts errors: a network failure never reads as a resolution miss', () => {
    const e = err(ErrorKind.NetworkError, 'HTTP 500 fetching https://example.invalid/mod.ts');
    strictEqual(Reflect.get(e, 'code'), 'ERR_MODULE_FETCH_FAILED');
    ok(!isResolutionMiss(e));
});
