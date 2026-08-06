// Disk-level test for the require()/import cycle guard.
//
// These import cts sources by relative path, so they exercise the TypeScript
// on disk rather than the copy baked into the binary. That matters here: the
// guard is what tests/cjs/require-cycle-esm.test.ts needs at runtime, and this
// file proves the surfaces it depends on behave correctly before a rebuild.
//
// What is proven: while a CJS body is on the stack, CjsLoader reports it as
// executing and names it as the innermost frame — exactly the state
// ModuleCompiler.load reads to decide whether an ESM import closes a cycle.
//
// ==========================================================================
// SCOPE WARNING — a green run here is NOT evidence that the guard is wired.
//
// makeLoader() below (and its twin further down) substitutes a HAND-WRITTEN
// loadEsmSync fake. Nothing in this file ever touches the real EsmCompiler,
// esmInFlightPaths/esmEvaluating, ModuleCompiler.evalTracked, or any
// entry-eval path. Reportedly these 8 tests passed while the cycle wiring was
// absent from the binary entirely (second-hand, not verified here) — which is
// the hazard this warning exists for either way.
//
// So this file tests the DETECTION PRIMITIVES in isolation, and only those.
// For end-to-end proof that the guard actually fires, use:
//   - tests/cjs/require-cycle-module.test.ts      (real EsmCompiler.isInFlight,
//                                                  real evaluation window; 11/0)
//   - tests/cjs/require-cycle-entry-eval.test.ts  (real evalTracked / entry eval;
//                                                  9/0)
//   - tests/cjs/require-cycle-esm.test.ts         (real CJS<->ESM cycle shapes;
//                                                  6 ok / 0 fail as of
//                                                  2026-08-03. This file used to
//                                                  record a KNOWN FAIL here for
//                                                  "require() of a mid-compile ESM
//                                                  module"; that red is FIXED, so
//                                                  a failure in it now is a real
//                                                  regression, not expected.)
// Those are the suites that regress when the wiring breaks. This one will not.
// ==========================================================================
import { ok, strictEqual } from 'node:assert';
import { CjsLoader } from '../../cts/src/compile/cjs.ts';
import { requireCycleError } from '../../cts/src/errors.ts';
import { makePosixTempDir } from '../_helpers/temp.ts';

const enc = new TextEncoder();

function write(path: string, body: string): void {
    Deno.writeFileSync(path, enc.encode(body));
}

interface Probe {
    executingDuringEsmLoad: boolean;
    innermostDuringEsmLoad: string | null;
}

/** CjsLoader wired so that a require() of an .mjs file runs `onEsm` — the same
 *  point at which the real ESM loader would re-enter and close the cycle. */
function makeLoader(dir: string, onEsm: (aPath: string) => void) {
    const aPath = `${dir}/a.cjs`;
    const deps = {
        resolveBuiltin(name: string) {
            return { specPath: `node:${name}`, localPath: `node:${name}`, format: 'esm', fileKind: 'source' } as any;
        },
        loadEsmSync(info: any) {
            // FAKE (see SCOPE WARNING at the top of this file). Stand-in for the
            // ESM pipeline: this is where bridge.ts's isInFlight check and
            // compile/index.ts's isExecuting check would run in the real loader.
            // Because this substitute is what runs, a green result here says
            // nothing about whether those checks are reached in the binary.
            onEsm(aPath);
            return { default: 'b-value' } as Record<string, unknown>;
        },
        resolveExternal(): any { return null; },
        prepareSource(code: string) { return code; },
    };
    return { loader: new CjsLoader(deps as any), aPath };
}

// --- 1. a CJS body on the stack is reported as executing ------------------

Deno.test('cts cycle: CjsLoader reports the requiring CJS file as executing during require(esm)', () => {
    const dir = makePosixTempDir('cjscycle');
    try {
        const probe: Probe = { executingDuringEsmLoad: false, innermostDuringEsmLoad: null };
        const { loader, aPath } = makeLoader(dir, (a) => {
            probe.executingDuringEsmLoad = loader.isExecuting(a);
            probe.innermostDuringEsmLoad = loader.innermostExecuting();
        });
        write(`${dir}/a.cjs`, "const b = require('./b.mjs');\nexports.value = 'a-value';\n");
        write(`${dir}/b.mjs`, "export default 'b-value';\n");

        loader.loadAndGet(aPath);

        ok(probe.executingDuringEsmLoad,
            'isExecuting(a.cjs) must be true while a.cjs is mid-require of an ESM dep — ' +
            'this is the state the ERR_REQUIRE_CYCLE_MODULE guard reads');
        strictEqual(probe.innermostDuringEsmLoad, aPath,
            'innermostExecuting() must name the CJS file whose require() closed the loop');
    } finally {
        try { Deno.removeSync(dir, { recursive: true }); } catch {}
    }
});

// --- 2. the executing set is cleared once the body returns -----------------
//
// A leaked entry would make every later import of that file a false cycle.
Deno.test('cts cycle: executing state is cleared after the CJS body completes', () => {
    const dir = makePosixTempDir('cjscycle');
    try {
        const { loader, aPath } = makeLoader(dir, () => {});
        write(`${dir}/a.cjs`, "const b = require('./b.mjs');\nexports.value = 'a-value';\n");
        write(`${dir}/b.mjs`, "export default 'b-value';\n");

        loader.loadAndGet(aPath);

        ok(!loader.isExecuting(aPath),
            'isExecuting must be false after load — a stale entry turns every ' +
            'later import of this file into a spurious cycle error');
        strictEqual(loader.innermostExecuting(), null, 'executing set must be empty');
    } finally {
        try { Deno.removeSync(dir, { recursive: true }); } catch {}
    }
});

// --- 3. a throwing body must not leak executing state ---------------------

Deno.test('cts cycle: a throwing CJS body still clears its executing entry', () => {
    const dir = makePosixTempDir('cjscycle');
    try {
        const { loader, aPath } = makeLoader(dir, () => {});
        write(`${dir}/a.cjs`, "throw new Error('boom');\n");

        let threw = false;
        try { loader.loadAndGet(aPath); } catch { threw = true; }

        ok(threw, 'the body must propagate its error');
        ok(!loader.isExecuting(aPath), 'executing entry must be cleared on the throw path too');
    } finally {
        try { Deno.removeSync(dir, { recursive: true }); } catch {}
    }
});

// --- 4. nested requires report the innermost frame ------------------------
//
// Node attributes the cycle to the module whose require() closed it, which is
// the innermost still-executing frame, not the outermost.
Deno.test('cts cycle: innermostExecuting names the deepest CJS frame, not the entry', () => {
    const dir = makePosixTempDir('cjscycle');
    try {
        const seen: (string | null)[] = [];
        const deps = {
            resolveBuiltin(name: string) {
                return { specPath: `node:${name}`, localPath: `node:${name}`, format: 'esm', fileKind: 'source' } as any;
            },
            // FAKE (see SCOPE WARNING at the top of this file): the real
            // loadEsmSync in cts/src/compile/bridge.ts is never called, so this
            // test cannot detect the guard being unwired.
            loadEsmSync() {
                seen.push(loader.innermostExecuting());
                return { default: 'x' } as Record<string, unknown>;
            },
            resolveExternal(): any { return null; },
            prepareSource(code: string) { return code; },
        };
        const loader = new CjsLoader(deps as any);

        write(`${dir}/outer.cjs`, "require('./inner.cjs');\nexports.done = 1;\n");
        write(`${dir}/inner.cjs`, "require('./dep.mjs');\nexports.done = 1;\n");
        write(`${dir}/dep.mjs`, "export default 'x';\n");

        loader.loadAndGet(`${dir}/outer.cjs`);

        strictEqual(seen.length, 1, 'the ESM dep must be loaded exactly once');
        strictEqual(seen[0], `${dir}/inner.cjs`,
            'attribution must be the innermost frame (inner.cjs), not outer.cjs');
    } finally {
        try { Deno.removeSync(dir, { recursive: true }); } catch {}
    }
});

// --- 5. the error object carries Node's code and both message shapes -------

Deno.test('cts cycle: requireCycleError carries ERR_REQUIRE_CYCLE_MODULE and Node message shapes', () => {
    const importCjs = requireCycleError('/x/a.cjs', '/x/b.mjs', 'import-cjs');
    strictEqual((importCjs as any).code, 'ERR_REQUIRE_CYCLE_MODULE');
    ok(/Cannot import CommonJS Module \/x\/a\.cjs in a cycle\./.test(importCjs.message),
        `import-cjs shape wrong: ${importCjs.message}`);
    ok(importCjs.message.includes('/x/b.mjs'), 'must attribute the importer');

    const requireEsm = requireCycleError('/x/a.mjs', '/x/b.cjs', 'require-esm');
    strictEqual((requireEsm as any).code, 'ERR_REQUIRE_CYCLE_MODULE');
    ok(/Cannot require\(\) ES Module \/x\/a\.mjs in a cycle\./.test(requireEsm.message),
        `require-esm shape wrong: ${requireEsm.message}`);
});

// --- 6. the guard decision itself: null when safe, error when mid-execution -
//
// importCycleError is exactly what ModuleCompiler.load throws on the ESM
// bridge path. Testing it here reaches the decision without building a
// resolver, so a rebuild is not needed to know the guard fires.
Deno.test('cts cycle: importCycleError returns an error only while the body is on the stack', () => {
    const dir = makePosixTempDir('cjscycle');
    try {
        const seen: { during: Error | null } = { during: null };
        const { loader, aPath } = makeLoader(dir, (a) => {
            seen.during = loader.importCycleError(a);
        });
        write(`${dir}/a.cjs`, "const b = require('./b.mjs');\nexports.value = 'a-value';\n");
        write(`${dir}/b.mjs`, "export default 'b-value';\n");

        // Before: nothing is executing, so importing a.cjs is legitimate.
        strictEqual(loader.importCycleError(aPath), null,
            'a file that is not executing must not be reported as a cycle');

        loader.loadAndGet(aPath);

        // During: this is the moment an ESM back-import would land.
        ok(seen.during instanceof Error,
            'importCycleError must yield an error while a.cjs is mid-require of its ESM dep');
        strictEqual((seen.during as any).code, 'ERR_REQUIRE_CYCLE_MODULE');
        ok(/Cannot import CommonJS Module/.test(seen.during!.message),
            `wrong message shape: ${seen.during!.message}`);
        ok(seen.during!.message.includes('a.cjs'), 'must name the module in the cycle');

        // After: the loaded module is importable again, no lingering error.
        strictEqual(loader.importCycleError(aPath), null,
            'a fully loaded file must be importable — a stale error would break ' +
            'every later import of it');
    } finally {
        try { Deno.removeSync(dir, { recursive: true }); } catch {}
    }
});

// --- 7. a preRegister stub is not a cycle ---------------------------------
//
// preRegister() caches never-executed stubs with loaded === false. If the
// guard keyed on the cache (or on `loaded`) instead of `executing`, every
// pre-registered CJS module would throw a spurious cycle error — which would
// break ordinary ESM-imports-CJS, not just cyclic graphs.
Deno.test('cts cycle: a pre-registered but unexecuted CJS stub is not reported as a cycle', () => {
    const dir = makePosixTempDir('cjscycle');
    try {
        const { loader, aPath } = makeLoader(dir, () => {});
        write(`${dir}/a.cjs`, "exports.value = 'a-value';\n");
        write(`${dir}/parent.mjs`, "export default 1;\n");

        loader.preRegister(aPath, `${dir}/parent.mjs`);

        ok(loader.cache.has(aPath), 'preRegister must cache a stub');
        strictEqual(loader.cache.get(aPath)!.loaded, false, 'the stub is not loaded');
        strictEqual(loader.importCycleError(aPath), null,
            'a cached-but-unexecuted stub must NOT be a cycle — keying on the ' +
            'cache or on `loaded` here would break plain ESM-imports-CJS');
    } finally {
        try { Deno.removeSync(dir, { recursive: true }); } catch {}
    }
});

// --- 8. host-path spelling must not defeat the guard ----------------------
//
// module.filename and require.resolve hand back Windows-style paths while the
// internal store is POSIX. A guard that compared raw strings would silently
// miss the cycle on Windows.
Deno.test('cts cycle: importCycleError normalizes path spelling', () => {
    const dir = makePosixTempDir('cjscycle');
    try {
        const hits: (Error | null)[] = [];
        const { loader, aPath } = makeLoader(dir, (a) => {
            hits.push(loader.importCycleError(a.replaceAll('/', '\\')));
        });
        write(`${dir}/a.cjs`, "const b = require('./b.mjs');\nexports.value = 'a';\n");
        write(`${dir}/b.mjs`, "export default 'b';\n");

        loader.loadAndGet(aPath);

        strictEqual(hits.length, 1);
        ok(hits[0] instanceof Error,
            'a backslash-spelled path must still be recognised as the executing module');
    } finally {
        try { Deno.removeSync(dir, { recursive: true }); } catch {}
    }
});
