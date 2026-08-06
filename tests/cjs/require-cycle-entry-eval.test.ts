// The entry-eval half of ERR_REQUIRE_CYCLE_MODULE.
//
// A module that require()s itself while it is the *process entry* aborted the
// process (rc=3, "assertion failed at quickjs.c:32126") instead of throwing
// ERR_REQUIRE_CYCLE_MODULE. The same cycle reached via require() from a CJS
// entry already threw correctly. The only difference was which site evaluated
// the module: loadEsmSync brackets its .eval() with esm.trackEvaluation
// (bridge.ts:117), so isInFlight sees the cycle; the CLI entry-eval sites called
// a bare `mod.eval()`, so neither esmInFlightPaths (cleared when compilation
// ends) nor esmEvaluating held the path. isInFlight returned false and .eval()
// was called on a module already in JS_MODULE_STATUS_EVALUATING — a status
// absent from js_link_module's assert allow-list (quickjs.c:32089, which permits
// only UNLINKED / LINKED / EVALUATING_ASYNC / EVALUATED).
//
// ModuleCompiler.evalTracked is that bracket, and these tests drive the real one
// from disk. They cover the window semantics the CLI sites depend on; the CLI
// wiring itself (src/commands/run.ts, src/commands/eval.ts) is baked into
// cno.exe and needs a rebuild to observe end-to-end.
import { strictEqual, ok } from 'node:assert';
import { writeFileSync } from 'node:fs';
import { makePosixTempDir } from '../_helpers/temp.ts';
import { EsmCompiler } from '../../cts/src/compile/esm.ts';
import { CjsLoader } from '../../cts/src/compile/cjs.ts';
import { ModuleCompiler } from '../../cts/src/compile/index.ts';
import { loadEsmSync } from '../../cts/src/compile/bridge.ts';
import { createConfig } from '../../cts/src/config.ts';
import type { ModuleInfo } from '../../cts/src/types.ts';

const engine = import.meta.use('engine');

function infoFor(localPath: string): ModuleInfo {
    return { specPath: localPath, localPath, format: 'esm', fileKind: 'source' };
}

/**
 * A ModuleCompiler carrying only the state evalTracked/remember touch.
 *
 * The real constructor calls installGlobalRequire + installInternalBridge, which
 * would replace this test worker's own globalThis.require and CTS_INTERNAL —
 * i.e. hijack the runtime executing the test. Object.create runs the real
 * prototype methods without that side effect.
 */
function compilerFor(esm: EsmCompiler): ModuleCompiler {
    const c = Object.create(ModuleCompiler.prototype) as ModuleCompiler;
    Reflect.set(c, 'esm', esm);
    Reflect.set(c, 'modulePaths', new WeakMap());
    return c;
}

function remember(c: ModuleCompiler, mod: CModuleEngine.Module, info: ModuleInfo): void {
    (Reflect.get(c, 'remember') as (m: unknown, i: ModuleInfo) => void).call(c, mod, info);
}

function setup(tag: string) {
    const dir = makePosixTempDir(tag);
    const esm = new EsmCompiler(createConfig({ cacheDir: `${dir}/cache`, disableLock: true }));
    return { dir, esm, compiler: compilerFor(esm) };
}

// --- 1. the fix: the real loadEsmSync throws inside evalTracked's window -----
//
// This is the whole causal chain end-to-end through the real code:
//   evalTracked opens the window -> isInFlight(self) is true
//   -> loadEsmSync throws ERR_REQUIRE_CYCLE_MODULE instead of re-.eval()ing
// The fixture performs the self-require from inside its own evaluation, which is
// exactly where the entry module's require() lands.

Deno.test('entry-eval: a self-require during evalTracked throws ERR_REQUIRE_CYCLE_MODULE', () => {
    const { dir, esm, compiler } = setup('ee-self');
    const selfPath = `${dir}/self.mjs`;
    const hook = '__ee_self_require';

    // The body calls the REAL loadEsmSync back on its own path, mid-evaluation.
    writeFileSync(selfPath, `globalThis[${JSON.stringify(hook)}]();\nexport const marker = 1;\n`);

    const info = infoFor(selfPath);
    const mod = esm.load(info, {});
    remember(compiler, mod, info);

    let caught: (Error & { code?: string }) | null = null;
    let ran = false;
    Reflect.set(globalThis, hook, () => {
        ran = true;
        try {
            loadEsmSync(info, esm, undefined, selfPath);
        } catch (e) {
            caught = e as Error & { code?: string };
        }
    });

    try {
        compiler.evalTracked(mod);
    } finally {
        Reflect.deleteProperty(globalThis, hook);
    }

    strictEqual(ran, true, 'the fixture body must have executed');
    ok(caught, 'the self-require must throw rather than re-evaluate (which aborts)');
    strictEqual(caught!.code, 'ERR_REQUIRE_CYCLE_MODULE',
        `expected Node's code, got: ${caught!.code} / ${caught!.message}`);
    ok(caught!.message.includes('Cannot require() ES Module'),
        `expected Node's message shape, got: ${caught!.message}`);
});

// --- 2. the defect mechanism, pinned without triggering it ------------------
//
// Deliberately does NOT call loadEsmSync unbracketed: that is the abort, and it
// would take the test process down. isInFlight === false during an unbracketed
// evaluation IS the precondition, and asserting it is enough.

Deno.test('entry-eval: an unbracketed eval leaves the module invisible to isInFlight', () => {
    const { dir, esm } = setup('ee-bare');
    const selfPath = `${dir}/bare.mjs`;
    const hook = '__ee_bare_probe';
    writeFileSync(selfPath, `globalThis[${JSON.stringify(hook)}]();\nexport const marker = 1;\n`);

    const mod = esm.load(infoFor(selfPath), {});

    let seen: boolean | null = null;
    Reflect.set(globalThis, hook, () => { seen = esm.isInFlight(selfPath); });
    try {
        mod.eval(); // the old entry-eval site: no bracket
    } finally {
        Reflect.deleteProperty(globalThis, hook);
    }

    strictEqual(seen, false,
        'unbracketed, the module is not in flight — loadEsmSync would re-.eval() '
        + 'a JS_MODULE_STATUS_EVALUATING module and abort');
});

// --- 3. narrowness: the window must not outlive the evaluation --------------
//
// If the bracket leaked, every later require() of the entry would throw a
// spurious cycle error. Re-.eval()ing an EVALUATED module is safe — that status
// IS in js_link_module's allow-list — so loadEsmSync must succeed here.

Deno.test('entry-eval: the window closes, so a post-evaluation require still works', () => {
    const { dir, esm, compiler } = setup('ee-after');
    const p = `${dir}/after.mjs`;
    writeFileSync(p, `export const value = 42;\n`);

    const info = infoFor(p);
    const mod = esm.load(info, {});
    remember(compiler, mod, info);

    compiler.evalTracked(mod);

    strictEqual(esm.isInFlight(p), false, 'the window must be closed after evalTracked returns');
    const ns = loadEsmSync(info, esm, undefined, `${dir}/other.cjs`);
    strictEqual(ns.value, 42, 'a require() after evaluation must return the namespace, not throw');
});

// --- 4. the throw path must not strand the flag -----------------------------

Deno.test('entry-eval: the window closes even when the entry throws', async () => {
    const { dir, esm, compiler } = setup('ee-throw');
    const p = `${dir}/boom.mjs`;
    writeFileSync(p, `throw new Error('boom');\n`);

    const info = infoFor(p);
    const mod = esm.load(info, {});
    remember(compiler, mod, info);

    const r = compiler.evalTracked(mod);

    // Checked BEFORE awaiting: trackEvaluation's finally runs when .eval()
    // returns, so the window must already be closed at this point regardless of
    // how the promise settles.
    strictEqual(esm.isInFlight(p), false,
        'a throwing entry must not leave its path permanently in flight — that '
        + 'would make every later require() of it throw a spurious cycle error');

    // Awaited the way the CLI entry sites do, so the rejection is handled.
    let caught: Error | null = null;
    try {
        await r;
    } catch (e) {
        caught = e as Error;
    }
    ok(caught, 'the entry\'s throw must still propagate to the caller');
    ok(/boom/.test(caught!.message), `expected the original error, got: ${caught!.message}`);

    strictEqual(esm.isInFlight(p), false, 'and it must stay closed after the rejection settles');
});

// --- 5. modules this compiler never loaded ---------------------------------
//
// evaluator.ts compiles CDP scripts with a raw `new engine.Module`, so they are
// not in modulePaths. evalTracked must fall through to a plain .eval() rather
// than key a window on undefined.

Deno.test('entry-eval: evalTracked falls back to a plain eval for an unregistered module', () => {
    const { esm, compiler } = setup('ee-unreg');
    const mod = new engine.Module(`globalThis.__ee_unreg = 7;\nexport default 7;\n`, '<unregistered>');

    compiler.evalTracked(mod);

    strictEqual(Reflect.get(globalThis, '__ee_unreg'), 7, 'the module must still evaluate');
    strictEqual(esm.isInFlight('<unregistered>'), false, 'nothing may be marked in flight');
    Reflect.deleteProperty(globalThis, '__ee_unreg');
});

// --- 7. the real load() -> remember() wiring -------------------------------
//
// Tests 1-6 register the path by calling remember directly. This one goes
// through the real ModuleCompiler.load(), which is what the CLI entry sites use,
// to prove the registry is actually populated by the load path rather than only
// by the test helper.

Deno.test('entry-eval: ModuleCompiler.load registers the path evalTracked needs', () => {
    const { dir, esm, compiler } = setup('ee-wired');
    const p = `${dir}/wired.mjs`;
    const hook = '__ee_wired_probe';
    writeFileSync(p, `globalThis[${JSON.stringify(hook)}]();\nexport const v = 5;\n`);

    // No remember() call: load() must do it.
    const mod = compiler.load(infoFor(p), {});

    let during: boolean | null = null;
    Reflect.set(globalThis, hook, () => { during = esm.isInFlight(p); });
    try {
        compiler.evalTracked(mod);
    } finally {
        Reflect.deleteProperty(globalThis, hook);
    }

    strictEqual(during, true,
        'load() must record localPath, otherwise evalTracked silently falls back '
        + 'to an unbracketed eval and the entry-eval abort returns');
    strictEqual(esm.isInFlight(p), false, 'and the window must still close');
});

// --- 8. the A/B control, disk-loaded: the CJS-entry direction ---------------
//
// The CJS-entry shape already behaved correctly before this change, so it is the
// regression control: if the bracket were too wide, it would break here. The
// spawned-binary A/B runs the baked cts and cannot see these edits, so the
// no-regression claim has to be made against the on-disk ModuleCompiler.
//
// A CJS entry goes through load()'s cjs branch: the body runs during
// loadAndGet, and evalTracked then brackets the *bridged wrapper*'s eval. A
// require(esm) from inside that body must still return the namespace — a bracket
// that covered too much would turn it into a spurious cycle error.

Deno.test('entry-eval: a CJS entry\'s require(esm) still succeeds (A/B control)', () => {
    const { dir, esm, compiler } = setup('ee-cjsentry');
    const depPath = `${dir}/dep.mjs`;
    const entryPath = `${dir}/entry.cjs`;
    writeFileSync(depPath, `export const value = 'from-esm';\n`);
    writeFileSync(entryPath,
        `const d = require('./dep.mjs');\n`
        + `exports.seen = d.value;\n`
        + `exports.ran = true;\n`);

    const cjs = new CjsLoader({
        resolveBuiltin: (name) => infoFor(`/builtin/${name}`),
        loadEsmSync: (info, from) => loadEsmSync(info, esm, undefined, from),
        resolveExternal: () => null,
        prepareSource: (code, filePath) => esm.transformer.transformForCjs(code, filePath),
    });
    Reflect.set(compiler, 'cjs', cjs);
    Reflect.set(compiler, 'resolver', { entry: entryPath });

    const entryInfo: ModuleInfo = {
        specPath: entryPath, localPath: entryPath, format: 'cjs', fileKind: 'source',
    };
    // load() runs the CJS body (including its require(esm)) and bridges it.
    const entryMod = compiler.load(entryInfo, {});
    compiler.evalTracked(entryMod);

    strictEqual(entryMod.namespace.ran, true, 'the CJS entry must still bridge its exports');
    strictEqual(entryMod.namespace.seen, 'from-esm',
        'require(esm) from a CJS entry must still return the namespace, not a cycle error');
    strictEqual(esm.isInFlight(entryPath), false, 'the entry path must not be stranded in flight');
    strictEqual(esm.isInFlight(depPath), false, 'nor the required ESM path');
});

// --- 9. narrowness by path: the bracket covers only the entry ---------------
//
// The window is keyed on the evaluated module's localPath. A require() of a
// *different* ESM module from inside the bracketed entry must load normally.

Deno.test('entry-eval: a require of a different module inside the window still loads', () => {
    const { dir, esm, compiler } = setup('ee-narrow');
    const entryPath = `${dir}/narrow.mjs`;
    const otherPath = `${dir}/other.mjs`;
    const hook = '__ee_narrow_probe';
    writeFileSync(otherPath, `export const value = 'other';\n`);
    writeFileSync(entryPath, `globalThis[${JSON.stringify(hook)}]();\nexport const v = 1;\n`);

    const entryInfo = infoFor(entryPath);
    const otherInfo = infoFor(otherPath);
    const mod = compiler.load(entryInfo, {});

    let loaded: unknown = null;
    let thrown: Error | null = null;
    Reflect.set(globalThis, hook, () => {
        try {
            loaded = loadEsmSync(otherInfo, esm, undefined, entryPath).value;
        } catch (e) {
            thrown = e as Error;
        }
    });
    try {
        compiler.evalTracked(mod);
    } finally {
        Reflect.deleteProperty(globalThis, hook);
    }

    strictEqual(thrown, null,
        `an unrelated require inside the window must not throw: ${thrown && (thrown as Error).message}`);
    strictEqual(loaded, 'other', 'and it must return the real namespace');
});


// --- 6. the registry is keyed per module ----------------------------------

Deno.test('entry-eval: remember keys the evaluation window by localPath', () => {
    const { dir, esm, compiler } = setup('ee-key');
    const p = `${dir}/keyed.mjs`;
    const hook = '__ee_keyed_probe';
    writeFileSync(p, `globalThis[${JSON.stringify(hook)}]();\nexport const v = 1;\n`);

    const info = infoFor(p);
    const mod = esm.load(info, {});
    remember(compiler, mod, info);

    let during: boolean | null = null;
    let other: boolean | null = null;
    Reflect.set(globalThis, hook, () => {
        during = esm.isInFlight(p);
        other = esm.isInFlight(`${dir}/unrelated.mjs`);
    });
    try {
        compiler.evalTracked(mod);
    } finally {
        Reflect.deleteProperty(globalThis, hook);
    }

    strictEqual(during, true, 'the evaluated module must be in flight under its localPath');
    strictEqual(other, false, 'the window must not cover unrelated paths');
});
