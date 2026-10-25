// File aliases must share cycle guards; explicit import views stay independent.
import { ok, strictEqual, throws } from 'node:assert';
import { join } from 'node:path';
import { EsmCompiler } from '../../../cts/src/compile/esm.ts';
import { ModuleCompiler } from '../../../cts/src/compile/index.ts';
import { loadEsmSync } from '../../../cts/src/compile/bridge.ts';
import { createConfig } from '../../../cts/src/config.ts';
import { err, ErrorKind, isResolutionMiss } from '../../../cts/src/errors.ts';
import { moduleEvaluationKey, moduleViewRef, type ModuleInfo } from '../../../cts/src/types.ts';
import { makePosixTempDir } from '../../_helpers/temp.ts';

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
        Deno.removeSync(dir, { recursive: true });
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
        Deno.removeSync(dir, { recursive: true });
    }
});

Deno.test('cts errors: a network failure never reads as a resolution miss', () => {
    const e = err(ErrorKind.NetworkError, 'HTTP 500 fetching https://example.invalid/mod.ts');
    strictEqual(Reflect.get(e, 'code'), 'ERR_MODULE_FETCH_FAILED');
    ok(!isResolutionMiss(e));
});

// Avoid reinstalling this test worker's global require/loader hooks while still
// exercising the real load -> remember -> evalTracked path.
function compilerFor(esm: EsmCompiler): ModuleCompiler {
    const compiler = Object.create(ModuleCompiler.prototype) as ModuleCompiler;
    Reflect.set(compiler, 'esm', esm);
    Reflect.set(compiler, 'modulePaths', new WeakMap());
    return compiler;
}

const identities = ['local', 'npm', 'moduleId'] as const;

function sourceInfo(path: string, identity: typeof identities[number]): ModuleInfo {
    return {
        specPath: identity === 'npm' ? `npm:cycle-fixture@1.0.0/${path.split('/').pop()}` : path,
        localPath: path,
        moduleId: identity === 'moduleId' ? moduleViewRef(path, 'source') : undefined,
        fileKind: 'source',
        format: 'esm',
        cacheBytecode: false,
    };
}

function assertGuarded(esm: EsmCompiler, info: ModuleInfo): void {
    // Check before attempting require: a broken guard must fail this test safely,
    // rather than re-evaluating an active native Module and aborting the worker.
    ok(esm.isInFlight(moduleEvaluationKey(info)), 'active module must be tracked');
    throws(() => loadEsmSync(info, esm), { code: 'ERR_REQUIRE_CYCLE_MODULE' });
    if (info.moduleId === undefined) {
        throws(() => loadEsmSync({ ...info, specPath: info.localPath }, esm), { code: 'ERR_REQUIRE_CYCLE_MODULE' });
    }
    ok(!esm.isInFlight(moduleViewRef(info.localPath, 'text')), 'another explicit view is independent');
}

Deno.test('cts cycle: nested alias loads preserve the outer compilation guard', () => {
    const dir = makePosixTempDir('cycle-nested-alias');
    const info = sourceInfo(`${dir}/entry.mjs`, 'local');
    const code = 'export const value = 42;';
    Deno.writeFileSync(info.localPath, new TextEncoder().encode(code));
    try {
        for (const loading of ['source', 'file', 'bytecode'] as const) {
            const esm = new EsmCompiler({ ...config(dir), enableCache: loading === 'bytecode' });
            const alias = {
                ...info,
                specPath: `npm:cycle-fixture@1.0.0/${loading}.mjs`,
                cacheBytecode: loading === 'bytecode',
            };
            const compile = esm.compileEsm.bind(esm);
            let nested = false;
            esm.compileEsm = (...args) => {
                if (args[1] === info.specPath) {
                    assertGuarded(esm, info);
                    if (loading === 'source') esm.loadSource(code, alias);
                    else esm.load(alias);
                    nested = true;
                    assertGuarded(esm, info);
                }
                return compile(...args);
            };
            if (loading === 'bytecode') {
                esm.jsc.load = () => {
                    assertGuarded(esm, alias);
                    return compile(code, alias.specPath, alias.localPath);
                };
            }
            try {
                esm.loadSource(code, info);
                strictEqual(nested, true, loading);
                strictEqual(esm.isInFlight(moduleEvaluationKey(info)), false, loading);
            } finally {
                esm.clearLoadedModules();
            }
        }
    } finally {
        Deno.removeSync(dir, { recursive: true });
    }
});

for (const identity of identities) {
    Deno.test(`cts cycle: ${identity} load and evalTracked refuse self-require`, async () => {
        const dir = makePosixTempDir(`cycle-eval-${identity}`);
        const info = sourceInfo(`${dir}/entry.mjs`, identity);
        const hook = `__cts_cycle_eval_${identity}`;
        const esm = new EsmCompiler(config(dir));
        const compiler = compilerFor(esm);
        if (identity === 'npm') {
            // This compiler owns a synthetic npm identity; the enclosing test
            // runtime has no corresponding package. Give only the native fixture
            // a disk name so its import.meta hook can resolve it during eval.
            const compile = esm.compileEsm.bind(esm);
            esm.compileEsm = (source, _moduleId, localPath) => compile(source, localPath, localPath);
        }
        Deno.writeFileSync(info.localPath, new TextEncoder().encode(
            `globalThis[${JSON.stringify(hook)}](); export const value = 42;`,
        ));
        let called = false;
        Reflect.set(globalThis, hook, () => { called = true; assertGuarded(esm, info); });
        try {
            const mod = compiler.load(info);
            await compiler.evalTracked(mod);
            strictEqual(called, true);
            strictEqual(esm.isInFlight(moduleEvaluationKey(info)), false);
            strictEqual(loadEsmSync(info, esm).value, 42);
        } finally {
            Reflect.deleteProperty(globalThis, hook);
            esm.clearLoadedModules();
            Deno.removeSync(dir, { recursive: true });
        }
    });

    Deno.test(`cts cycle: ${identity} source compilation refuses re-entry`, () => {
        const dir = makePosixTempDir(`cycle-compile-${identity}`);
        const info = sourceInfo(`${dir}/entry.mjs`, identity);
        const esm = new EsmCompiler(config(dir));
        const compile = esm.compileEsm.bind(esm);
        let compilations = 0;
        esm.compileEsm = (...args) => {
            compilations++;
            assertGuarded(esm, info);
            return compile(...args);
        };
        try {
            Deno.writeFileSync(info.localPath, new TextEncoder().encode('export const value = 42;'));
            esm.load(info);
            strictEqual(esm.isInFlight(moduleEvaluationKey(info)), false);
            esm.clearLoadedModules();
            esm.loadSource('export const value = 43;', info);
            strictEqual(compilations, 2);
            strictEqual(esm.isInFlight(moduleEvaluationKey(info)), false);
        } finally {
            esm.clearLoadedModules();
            Deno.removeSync(dir, { recursive: true });
        }
    });

    Deno.test(`cts cycle: ${identity} bytecode linking refuses re-entry`, () => {
        const dir = makePosixTempDir(`cycle-bytecode-${identity}`);
        const info = { ...sourceInfo(`${dir}/entry.mjs`, identity), cacheBytecode: true };
        const esm = new EsmCompiler({ ...config(dir), enableCache: true });
        let lookedUp = false;
        esm.jsc.load = () => {
            lookedUp = true;
            assertGuarded(esm, info);
            return null;
        };
        try {
            Deno.writeFileSync(info.localPath, new TextEncoder().encode('export const value = 42;'));
            esm.load(info);
            strictEqual(lookedUp, true);
            strictEqual(esm.isInFlight(moduleEvaluationKey(info)), false);
        } finally {
            esm.clearLoadedModules();
            Deno.removeSync(dir, { recursive: true });
        }
    });
}
