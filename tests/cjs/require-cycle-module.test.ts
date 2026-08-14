// ERR_REQUIRE_CYCLE_MODULE: a require()-crossed CJS<->ESM cycle must throw, not
// hand back a partially-initialized module.
//
// These tests import cts sources by relative path, so they exercise the
// TypeScript on disk rather than the copy baked into the binary.
//
// Measured against real Node v24.18.0: every cycle whose edges cross the
// CJS/ESM boundary via require() is refused with ERR_REQUIRE_CYCLE_MODULE,
// in two message shapes:
//   require(esm) where the ESM is in flight  -> "Cannot require() ES Module X in a cycle."
//   import cjs   where the CJS is on-stack   -> "Cannot import CommonJS Module X in a cycle."
// Pure-CJS cycles (partial exports) and pure-ESM cycles (TDZ) are NOT refused.
import { strictEqual, ok, throws } from 'node:assert';
import { writeFileSync } from 'node:fs';
import { makePosixTempDir } from '../_helpers/temp.ts';
import { requireCycleError } from '../../cts/src/errors.ts';
import { CjsLoader, type CjsDeps } from '../../cts/src/compile/cjs.ts';
import { EsmCompiler } from '../../cts/src/compile/esm.ts';
import { createConfig } from '../../cts/src/config.ts';
import type { ModuleInfo } from '../../cts/src/types.ts';

function infoFor(localPath: string, format: 'esm' | 'cjs'): ModuleInfo {
    return { specPath: localPath, localPath, format, fileKind: 'source' };
}

/** Minimal CjsDeps. `onEsm` stands in for the ESM pipeline. */
function makeDeps(onEsm: (info: ModuleInfo, from?: string) => Record<string, unknown>): CjsDeps {
    return {
        resolveBuiltin: (name) => infoFor(`/builtin/${name}`, 'esm'),
        loadEsmSync: (info, from) => onEsm(info, from),
        resolveExternal: () => null,
        prepareSource: () => null,
    };
}

// --- 1. the error shapes themselves ---------------------------------------

Deno.test('cycle: requireCycleError carries Node\'s code and both message shapes', () => {
    const a = requireCycleError('/x/a.cjs', '/x/b.mjs', 'import-cjs');
    strictEqual((a as { code?: string }).code, 'ERR_REQUIRE_CYCLE_MODULE');
    ok(a.message.includes('Cannot import CommonJS Module /x/a.cjs in a cycle.'),
        `got: ${a.message}`);
    ok(a.message.includes('/x/b.mjs'), 'must attribute the importing file');

    const b = requireCycleError('/x/b.mjs', '/x/entry.cjs', 'require-esm');
    strictEqual((b as { code?: string }).code, 'ERR_REQUIRE_CYCLE_MODULE');
    ok(b.message.includes('Cannot require() ES Module /x/b.mjs in a cycle.'),
        `got: ${b.message}`);
});

// --- 2. the detection surface: isExecuting during a CJS body --------------
//
// This is the state compile/index.ts consults before bridging a CJS module
// into the ESM graph. If it can see the on-stack body, Node's refusal is
// reachable; the CJS->ESM->CJS cycle is exactly this observation.

Deno.test('cycle: isExecuting() is true for a CJS body on the stack, false after', () => {
    const dir = makePosixTempDir('cyc-exec');
    const aPath = `${dir}/a.cjs`;
    writeFileSync(aPath, `exports.fromA = 'A'; require('./b.mjs');\n`);
    writeFileSync(`${dir}/b.mjs`, `export const value = 'b';\n`);

    let seenDuring: boolean | null = null;
    let innermost: string | null = null;
    const loader: CjsLoader = new CjsLoader(makeDeps(() => {
        // Stands in for compile/index.ts's CJS branch, reached while a.cjs runs.
        seenDuring = loader.isExecuting(aPath);
        innermost = loader.innermostExecuting();
        return { value: 'b' };
    }));

    loader.loadAndGet(aPath);
    strictEqual(seenDuring, true, 'a.cjs must be observable as executing from within its own body');
    strictEqual(innermost, aPath, 'innermostExecuting must name the frame that closed the loop');
    strictEqual(loader.isExecuting(aPath), false, 'the window must close after the body returns');
});

// --- 3. CJS -> ESM -> CJS: the ESM side sees the cycle and throws ---------
//
// The throw must propagate out of require() to the caller rather than being
// swallowed into a partial module.

Deno.test('cycle: CJS->ESM->CJS propagates ERR_REQUIRE_CYCLE_MODULE out of require()', () => {
    const dir = makePosixTempDir('cyc-mixed');
    const aPath = `${dir}/a.cjs`;
    writeFileSync(aPath, `exports.fromA = 'A';\nconst b = require('./b.mjs');\nexports.bSeen = b.value;\n`);
    writeFileSync(`${dir}/b.mjs`, `export const value = 'b';\n`);

    const loader: CjsLoader = new CjsLoader(makeDeps((info, from) => {
        // b.mjs imports back into a.cjs, which is still on the stack.
        if (loader.isExecuting(aPath)) {
            throw requireCycleError(aPath, from ?? loader.innermostExecuting() ?? '?', 'import-cjs');
        }
        return { value: 'b' };
    }));

    let code = '';
    let msg = '';
    try {
        loader.loadAndGet(aPath);
    } catch (e) {
        code = (e as { code?: string }).code ?? '';
        msg = (e as Error).message;
    }
    strictEqual(code, 'ERR_REQUIRE_CYCLE_MODULE', `expected the cycle error, got: ${msg}`);
    ok(msg.includes('Cannot import CommonJS Module'), `wrong shape: ${msg}`);
});

// --- 3b. importCycleError: the exact predicate compile/index.ts calls -------
//
// ModuleCompiler.load consults this before bridging a CJS module into the ESM
// graph. null means "importing this is legitimate"; non-null must be thrown.

Deno.test('cycle: importCycleError returns an error only while the body is on the stack', () => {
    const dir = makePosixTempDir('cyc-pred');
    const aPath = `${dir}/a.cjs`;
    writeFileSync(aPath, `exports.fromA = 'A'; require('./b.mjs');\n`);
    writeFileSync(`${dir}/b.mjs`, `export const value = 'b';\n`);

    let during: Error | null = null;
    const loader: CjsLoader = new CjsLoader(makeDeps(() => {
        during = loader.importCycleError(aPath);
        return { value: 'b' };
    }));

    // Before any execution: importing a.cjs is legitimate.
    strictEqual(loader.importCycleError(aPath), null, 'no cycle before execution starts');

    loader.loadAndGet(aPath);

    ok(during !== null, 'must report a cycle while a.cjs is mid-require');
    strictEqual((during as unknown as { code?: string }).code, 'ERR_REQUIRE_CYCLE_MODULE');
    ok((during as unknown as Error).message.includes('Cannot import CommonJS Module'),
        `wrong shape: ${(during as unknown as Error).message}`);
    strictEqual(loader.importCycleError(aPath), null, 'no cycle once the body has returned');
});

// --- 4. the `from` attribution is threaded through require(esm) -----------
//
// requireEsm must pass the requiring file to loadEsmSync so the error can name
// it, as Node's "(from ...)" suffix does.

Deno.test('cycle: require(esm) threads the requiring file to loadEsmSync', () => {
    const dir = makePosixTempDir('cyc-from');
    const aPath = `${dir}/a.cjs`;
    writeFileSync(aPath, `exports.x = require('./b.mjs').value;\n`);
    writeFileSync(`${dir}/b.mjs`, `export const value = 'b';\n`);

    let seenFrom: string | undefined;
    const loader = new CjsLoader(makeDeps((_info, from) => {
        seenFrom = from;
        return { value: 'b' };
    }));
    loader.loadAndGet(aPath);
    strictEqual(seenFrom, aPath, 'loadEsmSync must receive the requiring file for attribution');
});

// --- 5. NEGATIVE CONTROL: a fully loaded CJS module is not a cycle --------
//
// The guard must key on the executing stack, never on cache presence. Node
// allows require(esm) whose ESM imports an already-completed CJS module, and
// this is what keeps the require-esm-interop gate passing.

Deno.test('cycle: a fully loaded CJS module is not treated as a cycle', () => {
    const dir = makePosixTempDir('cyc-loaded');
    const aPath = `${dir}/a.cjs`;
    writeFileSync(aPath, `exports.fromA = 'A';\n`);
    writeFileSync(`${dir}/b.mjs`, `export const value = 'b';\n`);

    const loader: CjsLoader = new CjsLoader(makeDeps(() => {
        // Reached only after a.cjs finished, so this must NOT look like a cycle.
        strictEqual(loader.isExecuting(aPath), false,
            'a completed module must not be reported as executing');
        return { value: 'b' };
    }));

    const a = loader.loadAndGet(aPath);
    strictEqual((a.exports as { fromA: string }).fromA, 'A');
    ok(loader.cache.has(aPath), 'a.cjs must be cached');
    // Now require the ESM module: it is free to reach a.cjs.
    const req = loader.mkRequire(`${dir}/entry.cjs`);
    strictEqual((req('./b.mjs') as { value: string }).value, 'b');
});

// --- 6. NEGATIVE CONTROL: pure CJS cycles still yield partial exports -----
//
// Node does NOT refuse these. The fix must not turn them into errors.

Deno.test('cycle: pure CJS cycle still returns partial exports, no throw', () => {
    const dir = makePosixTempDir('cyc-purecjs');
    writeFileSync(`${dir}/a.cjs`,
        `exports.fromA = 'A';\nconst b = require('./b.cjs');\nexports.bSeen = b.fromB;\n`);
    writeFileSync(`${dir}/b.cjs`,
        `exports.fromB = 'B';\nconst a = require('./a.cjs');\nexports.aSeen = a.fromA ?? null;\n`);

    const loader = new CjsLoader(makeDeps(() => {
        throw new Error('no ESM involved in a pure CJS cycle');
    }));

    const a = loader.loadAndGet(`${dir}/a.cjs`).exports as Record<string, unknown>;
    strictEqual(a.fromA, 'A');
    strictEqual(a.bSeen, 'B');
    const b = loader.cache.get(`${dir}/b.cjs`)!.exports as Record<string, unknown>;
    strictEqual(b.aSeen, 'A', 'b must have seen a\'s partial exports, as in Node');
});

// --- 7. the esm.ts in-flight window (the surface bridge.ts consults) -------
//
// esmLoading alone cannot express this: esm.ts clears it when *compilation*
// finishes, long before evaluation ends. A CJS module reached during an ESM
// module's evaluation could then require() that module back, and .eval() on a
// module in JS_MODULE_STATUS_EVALUATING aborts the process (that status is
// absent from js_link_module's assert allow-list) rather than throwing.

Deno.test('cycle: EsmCompiler.isInFlight covers the evaluation window, keyed by localPath', () => {
    const dir = makePosixTempDir('cyc-esm');
    const esm = new EsmCompiler(createConfig({ cacheDir: `${dir}/cache`, disableLock: true }));
    const target = `${dir}/a.mjs`;

    strictEqual(esm.isInFlight(target), false, 'nothing in flight initially');

    let during: boolean | null = null;
    const out = esm.trackEvaluation(target, () => {
        during = esm.isInFlight(target);
        return 'evaluated';
    });
    strictEqual(out, 'evaluated', 'trackEvaluation must return the callback result');
    strictEqual(during, true, 'the module must be in flight during its own evaluation');
    strictEqual(esm.isInFlight(target), false, 'the window must close afterwards');
});

Deno.test('cycle: the evaluation window closes even when evaluation throws', () => {
    const dir = makePosixTempDir('cyc-esm-throw');
    const esm = new EsmCompiler(createConfig({ cacheDir: `${dir}/cache`, disableLock: true }));
    const target = `${dir}/a.mjs`;

    throws(() => esm.trackEvaluation(target, () => { throw new Error('boom'); }), /boom/);
    strictEqual(esm.isInFlight(target), false,
        'a throwing evaluation must not leave the module permanently in flight');
});

Deno.test('compiler: a source read failure does not strand ESM load state', () => {
    const dir = makePosixTempDir('esm-load-failure');
    const missing = `${dir}/missing.mjs`;
    const esm = new EsmCompiler(createConfig({ cacheDir: `${dir}/cache`, disableLock: true }));
    const info = infoFor(missing, 'esm');

    throws(() => esm.load(info), /./);
    strictEqual(esm.isInFlight(missing), false,
        'a failed source read must clear the in-flight path');
    strictEqual(esm.hasPendingLoads(), false,
        'a failed source read must clear the loading cache key');

    // A retry must execute the normal read path and fail again, rather than
    // returning the empty circular-dependency placeholder left by the first try.
    throws(() => esm.load(info), /./);
    strictEqual(esm.isInFlight(missing), false);
    strictEqual(esm.hasPendingLoads(), false);
});

// --- 10. self-require: the shortest path to .eval() on an EVALUATING module --
//
// A module that require()s itself is the minimal require()-crossed cycle. Node:
// ERR_REQUIRE_CYCLE_MODULE ("Cannot require() ES Module <self> in a cycle").
//
// MEASURED, both shapes, current binary:
//   self-require reached via require() from a CJS entry -> clean throw, ==Node
//   self-require in the *process entry* module          -> ABORT rc=3,
//       "assertion failed at quickjs.c:32126"
//
// The difference is purely which site evaluates it. loadEsmSync brackets its
// .eval() in trackEvaluation, so isInFlight sees the cycle and throws. The
// entry module is evaluated by the CLI (src/commands/run.ts, `await mod.eval()`)
// which is NOT bracketed, so neither esmInFlightPaths (cleared when compilation
// ends) nor esmEvaluating holds it; isInFlight returns false and .eval() is
// called on a module already in JS_MODULE_STATUS_EVALUATING.
//
// This test pins the half that is fixed. The entry-eval half needs the same
// bracket at the CLI eval site and is NOT fixed here.
Deno.test('cycle: a self-requiring module is a cycle whenever its eval is bracketed', () => {
    const dir = makePosixTempDir('cyc-self');
    const selfPath = `${dir}/self.mjs`;
    writeFileSync(selfPath, `export const v = 1;\n`);

    const esm = new EsmCompiler(createConfig({ cacheDir: `${dir}/cache`, disableLock: true }));

    // Inside its own bracketed evaluation, a module is in flight, so a
    // require() landing back on it is detected rather than re-evaluated.
    const seen = esm.trackEvaluation(selfPath, () => esm.isInFlight(selfPath));
    strictEqual(seen, true, 'a self-require during bracketed eval must be seen as a cycle');

    // Unbracketed, the very same module looks loadable — which is exactly why
    // the entry-eval path still aborts.
    strictEqual(esm.isInFlight(selfPath), false,
        'without the bracket the cycle is invisible (the entry-eval defect)');
});

// --- 11. KNOWN GAP (measured; mechanism NOT established) --------------------
//
// Node refuses both directions of a require()-crossed cycle. cno now closes the
// CJS-entry direction (tests above, confirmed end-to-end against the baked
// binary), but entering the same cycle at the ESM node still diverges:
//
//   entry.cjs requires b.mjs; b.mjs imports a.cjs; a.cjs requires b.mjs back
//   node: THREW ERR_REQUIRE_CYCLE_MODULE ("Cannot require() ES Module b.mjs")
//   cno : OK, and a.cjs observes b.value === undefined
//
// What is OBSERVED about the internals, via DEBUG=cjs/loader on the baked
// binary (which does contain esmEvaluating/trackEvaluation — verified with
// `grep -a -c`, since `strings` does not exist in this environment and returns
// a false 0 for everything):
//   - requireEsm IS entered twice for b.mjs (two `require('./b.mjs')` lines)
//   - esm.load runs only ONCE for b.mjs
//   - no "returning placeholder" line is emitted
//   - nothing throws
// So the second requireEsm returns before reaching esm.load, yet not via the
// placeholder path. The only such early return in requireEsm is the CJS cache
// hit, but `cache.set` for an ESM module happens *after* loadEsmSync returns,
// so that should not be populated yet. That contradiction is UNRESOLVED.
//
// This test therefore pins only the cache short-circuit as a *fact about
// requireEsm* — it does NOT assert that this is the cause of the gap above.
// An earlier revision of this comment claimed it was; that claim was unproven
// and has been withdrawn.
Deno.test('cycle: requireEsm serves a repeat require(esm) from the CJS cache', () => {
    const dir = makePosixTempDir('cyc-gap');
    writeFileSync(`${dir}/a.cjs`, `exports.fromA = 'A';\n`);
    writeFileSync(`${dir}/b.mjs`, `export const value = 'b';\n`);

    let esmCalls = 0;
    const loader = new CjsLoader(makeDeps(() => { esmCalls++; return { value: 'b' }; }));
    const req = loader.mkRequire(`${dir}/entry.cjs`);

    strictEqual((req('./b.mjs') as { value: string }).value, 'b');
    strictEqual(esmCalls, 1, 'first require(esm) must reach the ESM pipeline');

    // The second require is served from the CJS cache without consulting the
    // ESM side at all. That short-circuit is why an in-flight guard living only
    // inside loadEsmSync cannot observe a cycle re-entering through this path.
    strictEqual((req('./b.mjs') as { value: string }).value, 'b');
    strictEqual(esmCalls, 1, 'repeat require(esm) is served from the CJS cache');
});
