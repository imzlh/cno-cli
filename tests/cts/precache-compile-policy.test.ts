import { ok, strictEqual } from 'node:assert';
import { readFileSync } from 'node:fs';

/**
 * Precache used to swallow compileModules batch failures with log.warn and
 * still return success — same heritage class as silent half-graph finish.
 * Ship policy: rethrow after cleanup; per-module fails warn in aggregate.
 */
Deno.test('precache policy: batch compile failure is not silent success', () => {
    const runtimeSrc = readFileSync(new URL('../../cts/src/runtime/index.ts', import.meta.url), 'utf8');
    // compileModules call site must not sit in a catch that only warns.
    ok(runtimeSrc.includes('parseDriver.compileModules'), 'precache still drives ParseDriver.compileModules');
    ok(runtimeSrc.includes('batch failed'), 'batch failures are logged as batch failed');
    // After batch catch, must rethrow (not fall through to return result as success).
    const catchIdx = runtimeSrc.indexOf("log.warn('precompile', () => `batch failed:");
    ok(catchIdx > 0, 'batch-failed warn present');
    const after = runtimeSrc.slice(catchIdx, catchIdx + 500);
    ok(after.includes('throw '), 'batch failure rethrows instead of soft-continue');
    // Cleanup must cover the rethrow, but NOT by an inline terminate() in the
    // catch: precache wraps the whole body in `try { ... } finally { await
    // parseDriver.terminate() }`, so the throw above is already covered on every
    // exit path (including a throw from flushLock()/hasFresh(), which an inline
    // catch-only terminate would miss). Asserting the inline form would demand a
    // double terminate. Measured: the terminate sits 1084 chars after the warn,
    // so the old 500-char window could never see it.
    const afterCatchToTerminate = runtimeSrc.slice(catchIdx, runtimeSrc.indexOf('parseDriver.terminate()', catchIdx) + 40);
    ok(
        /\}\s*finally\s*\{/.test(afterCatchToTerminate),
        'batch failure rethrow must be enclosed by a finally block',
    );
    ok(
        afterCatchToTerminate.includes('parseDriver.terminate()'),
        'that finally must terminate the parse workers, so the rethrow cannot leak them',
    );
    // Per-module failures still counted and warned (not only debug-skip forever).
    ok(runtimeSrc.includes('failed to precompile'), 'aggregate per-module fail warning');
    // Dual public surface must not reappear via api barrel.
    const apiSrc = readFileSync(new URL('../../cts/src/api/index.ts', import.meta.url), 'utf8');
    strictEqual(apiSrc.includes('PrecompileDriver'), false);
    strictEqual(apiSrc.includes('isCompilerWorker'), false);
    strictEqual(apiSrc.includes('runCompilerWorker'), false);
});

/**
 * ESM compileForCache builds engine.Module under active onModule hooks.
 * Without a stub loader, a missing relative / optional peer / .node edge
 * cascade-fails the parent module's bytecode even when the file itself is fine.
 * Precache only needs single-module bytecode — runtime loads the real graph.
 */
Deno.test('precache policy: compileModules uses stub loader (no full-graph resolve)', () => {
    const runtimeSrc = readFileSync(new URL('../../cts/src/runtime/index.ts', import.meta.url), 'utf8');
    ok(runtimeSrc.includes('precompileStubLoader'), 'stub loader helper exists');
    ok(runtimeSrc.includes('cts-precompile-stub:'), 'stub ids are namespaced');
    ok(runtimeSrc.includes('withStubModuleLoader(precompileStubLoader()'),
        'precache wraps compileModules in withStubModuleLoader');
    // Empty Module.create stubs — same idea as pack/writer, not real resolve.
    const stubFn = runtimeSrc.indexOf('function precompileStubLoader');
    ok(stubFn > 0, 'precompileStubLoader defined');
    const stubBody = runtimeSrc.slice(stubFn, stubFn + 800);
    ok(stubBody.includes('engine.Module.create'), 'stubs are empty Module.create');
    // Must not call real resolver from the stub resolve path.
    ok(!stubBody.includes('this.resolver'), 'stub resolve does not touch ModuleResolver');

    const parseSrc = readFileSync(new URL('../../cts/src/parse.ts', import.meta.url), 'utf8');
    ok(parseSrc.includes('stub onModule'), 'parse documents onModule dependency');
});

/** Native addons are not JS source — never enqueue for bytecode precompile. */
Deno.test('precache policy: isPrecompilePath rejects .node', () => {
    const runtimeSrc = readFileSync(new URL('../../cts/src/runtime/index.ts', import.meta.url), 'utf8');
    const fn = runtimeSrc.indexOf('function isPrecompilePath');
    ok(fn > 0, 'isPrecompilePath defined');
    // Guard must return false before extension allow-list for ".node".
    const body = runtimeSrc.slice(fn, fn + 1200);
    ok(body.includes('return false'), 'has early false returns');
    // char codes for ".node": 46,110,111,100,101 — keeps the check allocation-free.
    ok(body.includes('=== 110') && body.includes('=== 111') && body.includes('=== 100') && body.includes('=== 101'),
        '.node suffix rejected via charCode checks');
    // .mts/.cts are TS-family runtime sources (not only plain .ts).
    ok(body.includes('third === 109') && body.includes('third === 99'),
        '.mts/.cts included in precompile allow-list');
    ok(body.includes('isTypeDecl'), 'type declarations excluded via isTypeDecl');
});

/** CJS precompile must strip TS via transformForCjs — workers only ESM-transform. */
Deno.test('precompile policy: CJS modules use transformForCjs on main thread', () => {
    const parseSrc = readFileSync(new URL('../../cts/src/parse.ts', import.meta.url), 'utf8');
    ok(parseSrc.includes('prepareForCache'), 'prepareForCache helper exists');
    ok(parseSrc.includes('transformForCjs'), 'CJS path uses transformForCjs');
    ok(parseSrc.includes("format === 'cjs'"), 'CJS modules detected by format');
    ok(parseSrc.includes('compileOnMain') || parseSrc.includes('mainThread'),
        'CJS stays on main thread (not worker ESM transform)');
});

Deno.test('public API surface: only ParseDriver / isParseWorker worker symbols', () => {
    const precompileShim = readFileSync(new URL('../../cts/src/precompile.ts', import.meta.url), 'utf8');
    ok(precompileShim.includes('ParseDriver'));
    ok(precompileShim.includes('isParseWorker'));
    ok(precompileShim.includes('runParseWorker'));
    ok(!precompileShim.includes('PrecompileDriver'));
    ok(!precompileShim.includes('isCompilerWorker'));
    ok(!precompileShim.includes('runCompilerWorker'));
});
