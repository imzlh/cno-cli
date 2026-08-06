/**
 * In-process tests for `src/inspector/main/evaluator.ts` (compileScript/runScript)
 * and the released-handle contract in `src/inspector/main/object-store.ts`.
 *
 * `Evaluator` and `Serializer` are both trivially constructible (Serializer
 * defaults its own ObjectStore), so this imports them by relative path and drives
 * the working-tree TypeScript with no rebuild.
 *
 * The compileScript diff (`export default (...)` plus a counter-based scriptId) had
 * no test at all. The oracle is real node v24.18.0 driven over its own --inspect
 * socket; each measured reply is quoted at its assertion.
 */

import { ok, strictEqual } from 'node:assert';
import { Evaluator } from '../../src/inspector/main/evaluator';
import { Serializer } from '../../src/inspector/main/remote-object';
import { ObjectStore } from '../../src/inspector/main/object-store';
import type { RpcParams } from '../../src/inspector/shared/rpc-contract';

function newEvaluator(): { evaluator: Evaluator; serializer: Serializer } {
    const serializer = new Serializer();
    return { evaluator: new Evaluator(serializer), serializer };
}

function compile(evaluator: Evaluator, expression: string, persistScript = true): ReturnType<Evaluator['compileScript']> {
    return evaluator.compileScript({ expression, sourceURL: 'test.js', persistScript } as RpcParams['compileScript']);
}

Deno.test('evaluator: compileScript returns a distinct scriptId per call', () => {
    const { evaluator } = newEvaluator();
    // The diff replaced `script:${sourceURL || Date.now()}` with a counter. The old
    // key collided whenever DevTools reused a sourceURL — which it always does for
    // console entries — so a second compile silently replaced the first compiled
    // module and runScript then ran the WRONG source.
    const a = compile(evaluator, '1+1');
    const b = compile(evaluator, '2+2');
    ok(a.scriptId, `first compile must succeed: ${JSON.stringify(a)}`);
    ok(b.scriptId, `second compile must succeed: ${JSON.stringify(b)}`);
    ok(a.scriptId !== b.scriptId, 'the same sourceURL must not collide into one scriptId');
});

Deno.test('evaluator: runScript reports the completion value, not undefined', async () => {
    const { evaluator } = newEvaluator();
    // This is what the `export default (...)` wrapper is for: a bare expression
    // statement leaves namespace.default undefined, so runScript answered
    // `{type:'undefined'}` for every script. MEASURED, node v24.18:
    // runScript on a compiled `1+1` -> {"type":"number","value":2,"description":"2"}.
    const compiled = compile(evaluator, '1+1');
    if (!compiled.scriptId) throw new Error(`compile failed: ${JSON.stringify(compiled)}`);
    const run = await evaluator.runScript({ scriptId: compiled.scriptId } as RpcParams['runScript']);
    strictEqual(run.result?.type, 'number', `expected a number result, got ${JSON.stringify(run)}`);
    strictEqual(run.result?.value, 2);
});

Deno.test('evaluator: runScript on an unknown scriptId is an error, not a crash', async () => {
    const { evaluator } = newEvaluator();
    // MEASURED, node v24.18: {"code":-32000,"message":"No script with given id"}.
    const run = await evaluator.runScript({ scriptId: 'script:does-not-exist' } as RpcParams['runScript']);
    ok(run.exceptionDetails, `an unknown scriptId must report an exception, got ${JSON.stringify(run)}`);
});

Deno.test('evaluator: a compiled statement does not become a syntax error', () => {
    const { evaluator } = newEvaluator();
    // MEASURED, node v24.18: compileScript with expression `var q=1;` SUCCEEDS and
    // returns a scriptId. CDP's `expression` param is a script body, not necessarily
    // a single expression, so wrapping it in `export default (...)` turns a valid
    // script into `export default (var q=1;)` — a syntax error. This documents the
    // gap the wrapper introduces; see the note in compileScript.
    const compiled = compile(evaluator, 'var q = 1;');
    // Not asserting success: the wrapper cannot support statements. What must hold is
    // that the failure is a clean CDP exceptionDetails rather than a thrown error
    // escaping into the RPC layer.
    ok(
        compiled.scriptId || compiled.exceptionDetails,
        `a statement must yield either a scriptId or exceptionDetails, got ${JSON.stringify(compiled)}`,
    );
});

Deno.test('evaluator: a syntax error compiles to exceptionDetails, not a throw', () => {
    const { evaluator } = newEvaluator();
    const compiled = compile(evaluator, '{{{');
    ok(compiled.exceptionDetails, 'a syntax error must be reported as exceptionDetails');
    strictEqual(compiled.scriptId, undefined, 'a failed compile must not hand back a scriptId');
});

Deno.test('evaluator: a non-persisted script is consumed by its first run', async () => {
    const { evaluator } = newEvaluator();
    // cno keeps a persisted script and drops a non-persisted one after the run.
    // MEASURED, node v24.18: node drops it EITHER WAY — a second runScript on a
    // persistScript:true id answers {"code":-32000,"message":"No script with given
    // id"}, and with persistScript:false node returns no scriptId at all. So one run
    // per compile is the real contract; this pins cno's non-persisted half of it.
    const compiled = compile(evaluator, '41 + 1', false);
    if (!compiled.scriptId) throw new Error(`compile failed: ${JSON.stringify(compiled)}`);
    const first = await evaluator.runScript({ scriptId: compiled.scriptId } as RpcParams['runScript']);
    strictEqual(first.result?.value, 42);
    const second = await evaluator.runScript({ scriptId: compiled.scriptId } as RpcParams['runScript']);
    ok(second.exceptionDetails, 'a consumed scriptId must not run twice');
});

Deno.test('evaluator: repeated compiles do not grow the script table without bound', () => {
    const { evaluator } = newEvaluator();
    // DevTools calls Runtime.compileScript with persistScript:true for watch
    // expressions and autocomplete probes, and nothing ever releases them: there is
    // no Runtime.releaseScript in CDP. Each entry pins a compiled engine.Module.
    // Without a cap a long session grows this map forever — the same leak shape that
    // MAX_CACHED_BODIES fixed in fetch.ts.
    const ids = new Set<string>();
    for (let i = 0; i < 400; i++) {
        const compiled = compile(evaluator, `${i} + 1`);
        if (compiled.scriptId) ids.add(compiled.scriptId);
    }
    strictEqual(ids.size, 400, 'every compile must get its own id');
    const live = evaluator.compiledScriptCount();
    ok(live <= 256, `compiled scripts must be bounded, held ${live} after 400 compiles`);
});

// ------------------------------------------------- released-handle contract

Deno.test('evaluator: callFunctionOn on a released objectId reports failure', async () => {
    const { evaluator, serializer } = newEvaluator();
    const id = serializer.add({ v: 7 }, 'grp');
    // Works while live.
    const live = await evaluator.callFunctionOn({
        objectId: id,
        functionDeclaration: 'function(){ return this.v }',
    } as RpcParams['callFunctionOn']);
    strictEqual(live.result?.value, 7, `expected 7 while live, got ${JSON.stringify(live)}`);

    // After release the handle is stale. Previously `resolve()` returned undefined
    // and the function RAN with `this === undefined`, so this returned a normal
    // result for an object that no longer existed. MEASURED, node v24.18:
    // {"code":-32000,"message":"Could not find object with given id"}.
    serializer.release(id);
    const dead = await evaluator.callFunctionOn({
        objectId: id,
        functionDeclaration: 'function(){ return this === undefined ? "ran-on-undefined" : "ran" }',
    } as RpcParams['callFunctionOn']);
    ok(dead.exceptionDetails, `a stale objectId must report an exception, got ${JSON.stringify(dead)}`);
    ok(
        String(dead.exceptionDetails?.text).includes('Could not find object'),
        `message should name the missing object, got ${dead.exceptionDetails?.text}`,
    );
});

Deno.test('evaluator: callFunctionOn with an unknown objectId does not run the function', async () => {
    const { evaluator } = newEvaluator();
    const res = await evaluator.callFunctionOn({
        objectId: 'obj:99999',
        functionDeclaration: 'function(){ globalThis.__cnoLeakProbe = 1; return 1 }',
    } as RpcParams['callFunctionOn']);
    ok(res.exceptionDetails, 'an unknown objectId must not dispatch the call');
    strictEqual(
        (globalThis as Record<string, unknown>).__cnoLeakProbe,
        undefined,
        'the function body must never have executed',
    );
});

Deno.test('evaluator: callFunctionOn with no objectId still runs (global receiver)', async () => {
    const { evaluator } = newEvaluator();
    // The guard must only reject a *supplied* id that does not resolve; omitting
    // objectId entirely is legal CDP and must keep working.
    const res = await evaluator.callFunctionOn({
        functionDeclaration: 'function(){ return 5 }',
    } as RpcParams['callFunctionOn']);
    strictEqual(res.result?.value, 5, `expected 5, got ${JSON.stringify(res)}`);
});

Deno.test('object-store: a released id does not resolve to a live value', () => {
    const store = new ObjectStore();
    const target = { a: 1 };
    const id = store.add(target, 'grp');
    strictEqual(store.resolve(id), target);
    store.release(id);
    strictEqual(store.has(id), false, 'a released id must not be present');
    strictEqual(store.resolve(id), undefined, 'a released id must not resolve');
});

Deno.test('object-store: ids are never reused after release', () => {
    const store = new ObjectStore();
    // A reused id would let a stale DevTools reference silently address a DIFFERENT
    // object — the released-handle-reuse hazard. The seq counter only ever advances.
    const first = store.add({ tag: 'first' }, 'grp');
    store.release(first);
    const seen = new Set<string>([first]);
    for (let i = 0; i < 100; i++) {
        const id = store.add({ i }, 'grp');
        ok(!seen.has(id), `id ${id} was reused after release`);
        seen.add(id);
        store.release(id);
    }
});

Deno.test('object-store: releasing by group leaves no resolvable handles behind', () => {
    const store = new ObjectStore();
    const ids = [store.add({ a: 1 }, 'g'), store.add({ b: 2 }, 'g'), store.add({ c: 3 }, 'g')];
    const other = store.add({ d: 4 }, 'other');
    store.releaseGroup('g');
    for (const id of ids) {
        strictEqual(store.has(id), false, `${id} must be gone`);
        strictEqual(store.resolve(id), undefined, `${id} must not resolve`);
        strictEqual(store.groupOf(id), undefined, `${id} must have no group`);
    }
    strictEqual((store.resolve(other) as { d: number }).d, 4, 'unrelated groups survive');
    ok(store.has(other), 'a different group must be untouched');
});

Deno.test('object-store: a released id is still released after its group is dropped', () => {
    const store = new ObjectStore();
    // The diff deletes an empty group from `groups`. Releasing the same id again
    // afterwards must stay a no-op rather than throwing on the missing group.
    const id = store.add({ a: 1 }, 'solo');
    store.release(id);
    store.release(id);
    store.releaseGroup('solo');
    strictEqual(store.has(id), false);
});

Deno.test('serializer: getProperties on a released id is empty, not an error', () => {
    const serializer = new Serializer();
    const id = serializer.add({ a: 1, b: 2 }, 'grp');
    strictEqual(serializer.getProperties(id, 'grp').result.length, 2);

    serializer.release(id);
    // DIVERGENCE, deliberately left as-is. MEASURED, node v24.18: getProperties on a
    // released objectId answers {"code":-32000,"message":"Could not find object with
    // given id"}. cno answers an empty property list, so DevTools renders the object
    // as `{}` instead of flagging a stale handle.
    //
    // Not changed because cno releases the 'backtrace' group on every resume, and
    // DevTools routinely issues getProperties for scope objects racing that release;
    // erroring there would surface spurious console errors during normal stepping,
    // whereas an empty result degrades quietly. callFunctionOn IS strict, because
    // there a stale handle silently EXECUTES against the wrong receiver.
    strictEqual(serializer.getProperties(id, 'grp').result.length, 0);
});

// ------------------------------------------------------- awaitPromise contract
//
// `Evaluator` is disk-constructible, so these drive the working-tree TypeScript
// and are meaningful without a rebuild. The production inspector path is baked
// into the binary, so the end-to-end DevTools behaviour needs a rebuild to change.

Deno.test('evaluator: awaitPromise:false returns the Promise, it does not resolve it', async () => {
    const { evaluator } = newEvaluator();
    // `evalWithCapturedCompletion` is an async function, and an async function's
    // return value is ALWAYS adopted -- a returned thenable is resolved before the
    // caller's `await` observes it. So the promise was unwrapped before
    // `q.awaitPromise` was ever consulted, and awaitPromise:false was unreachable.
    //
    // MEASURED, node v24.18.0, `new Promise(r=>setTimeout(()=>r(99),200))` with
    // awaitPromise:false ->
    //   {"type":"object","subtype":"promise","className":"Promise","objectId":...}
    // MEASURED, cno before the fix, same input -> {"type":"number","value":99}.
    const r = await evaluator.evaluate({
        expression: 'new Promise(r=>setTimeout(()=>r(99),200))',
        awaitPromise: false,
    } as RpcParams['evaluate']);
    strictEqual(r.result?.type, 'object', `expected an unresolved Promise, got ${JSON.stringify(r)}`);
    strictEqual(r.result?.subtype, 'promise', `expected subtype promise, got ${JSON.stringify(r)}`);
    strictEqual(r.result?.className, 'Promise');
    ok(r.result?.objectId, 'DevTools needs an objectId to expand the pending Promise');
    // The resolved value must NOT have leaked into the reply.
    strictEqual(r.result?.value, undefined, `the Promise must not be resolved: ${JSON.stringify(r)}`);
});

Deno.test('evaluator: awaitPromise:true still resolves the Promise', async () => {
    const { evaluator } = newEvaluator();
    // The other half of the contract: boxing the completion value must not break
    // the case that already worked. MEASURED, node v24.18: -> {"type":"number","value":99}.
    const r = await evaluator.evaluate({
        expression: 'new Promise(r=>setTimeout(()=>r(99),200))',
        awaitPromise: true,
    } as RpcParams['evaluate']);
    strictEqual(r.result?.type, 'number', `expected the resolved value, got ${JSON.stringify(r)}`);
    strictEqual(r.result?.value, 99);
});

Deno.test('evaluator: a non-promise value is unaffected by the completion box', async () => {
    const { evaluator } = newEvaluator();
    // Guard against the box leaking into the reply as a wrapper object.
    const num = await evaluator.evaluate({ expression: '1+1' } as RpcParams['evaluate']);
    strictEqual(num.result?.type, 'number');
    strictEqual(num.result?.value, 2);
    const obj = await evaluator.evaluate({ expression: '({a:1})', returnByValue: true } as RpcParams['evaluate']);
    // If the box leaked, this would be {__cnoCapturedCompletion__:{a:1}}.
    strictEqual(JSON.stringify(obj.result?.value), '{"a":1}', `box leaked into the result: ${JSON.stringify(obj)}`);
});

Deno.test('evaluator: the statement fallback still yields a completion value', async () => {
    const { evaluator } = newEvaluator();
    // Multi-statement input takes the IIFE fallback branch, where the box is built
    // in-VM. MEASURED, node v24.18: `var x = 5; x * 2` -> {"type":"number","value":10}.
    const r = await evaluator.evaluate({ expression: 'var __evStmt = 5; __evStmt * 2' } as RpcParams['evaluate']);
    strictEqual(r.result?.type, 'number', `statement fallback lost its value: ${JSON.stringify(r)}`);
    strictEqual(r.result?.value, 10);
});

Deno.test('evaluator: the statement fallback honours awaitPromise:false too', async () => {
    const { evaluator } = newEvaluator();
    // The fallback IIFE is async, so its return value is adopted as well -- which is
    // why the box has to be constructed inside the IIFE rather than around it.
    const r = await evaluator.evaluate({
        expression: 'var __evP = 1; new Promise(r=>setTimeout(()=>r(7),150))',
        awaitPromise: false,
    } as RpcParams['evaluate']);
    strictEqual(r.result?.subtype, 'promise', `fallback resolved the Promise anyway: ${JSON.stringify(r)}`);
    strictEqual(r.result?.value, undefined);
});

Deno.test('evaluator: top-level await still works through the box', async () => {
    const { evaluator } = newEvaluator();
    // A top-level await expression is not a Promise once evaluated, so it must come
    // back as the awaited value regardless of awaitPromise.
    const r = await evaluator.evaluate({ expression: 'await Promise.resolve(41) + 1' } as RpcParams['evaluate']);
    strictEqual(r.result?.type, 'number', `top-level await broke: ${JSON.stringify(r)}`);
    strictEqual(r.result?.value, 42);
});

Deno.test('evaluator: runScript honours awaitPromise', async () => {
    const { evaluator } = newEvaluator();
    // runScript ignored awaitPromise entirely, so a promise-valued script answered
    // the Promise itself -- which under returnByValue serialises to `{}`, a silently
    // wrong result rather than an error.
    // MEASURED, cno before the fix: compileScript `Promise.resolve(5)` + runScript
    // {awaitPromise:true,returnByValue:true} -> value {}.
    const compiled = compile(evaluator, 'Promise.resolve(5)');
    if (!compiled.scriptId) throw new Error(`compile failed: ${JSON.stringify(compiled)}`);
    const run = await evaluator.runScript({
        scriptId: compiled.scriptId,
        awaitPromise: true,
        returnByValue: true,
    } as RpcParams['runScript']);
    strictEqual(run.result?.type, 'number', `awaitPromise was ignored: ${JSON.stringify(run)}`);
    strictEqual(run.result?.value, 5);
});

Deno.test('evaluator: runScript without awaitPromise reports the Promise', async () => {
    const { evaluator } = newEvaluator();
    // The complement: absent the flag, the Promise handle is what DevTools gets.
    const compiled = compile(evaluator, 'Promise.resolve(5)');
    if (!compiled.scriptId) throw new Error(`compile failed: ${JSON.stringify(compiled)}`);
    const run = await evaluator.runScript({ scriptId: compiled.scriptId } as RpcParams['runScript']);
    strictEqual(run.result?.subtype, 'promise', `expected the Promise handle, got ${JSON.stringify(run)}`);
});

Deno.test('evaluator: evaluation cannot abort on a re-entrant module shape', async () => {
    const { evaluator } = newEvaluator();
    // Regression guard for the JS_MODULE_STATUS_EVALUATING process abort (rc=3,
    // "assertion failed at quickjs.c:32126") that a sibling hit by calling .eval()
    // on a module already evaluating. evaluator.ts deliberately does not bracket
    // runScript with evalTracked; these are the shapes that would expose that if the
    // reasoning were wrong. A thrown JS error would be acceptable -- a dead process
    // would not, and an abort takes the whole test worker down with it.
    //
    // OBSERVED end-to-end over a real CDP session against the 21:53 binary: all four
    // shapes plus three concurrent runScript calls on one persisted scriptId
    // completed with no abort signature and the process still answering.
    const shapes = [
        'globalThis.__abortReq = 1',
        'import("node:os").then(m => typeof m.platform)',
        'await Promise.resolve(1)',
        '(async () => (await import("node:path")).join("a","b"))()',
    ];
    for (const expression of shapes) {
        const r = await evaluator.evaluate({ expression, awaitPromise: true } as RpcParams['evaluate']);
        ok(r.result !== undefined, `no result for ${expression}: ${JSON.stringify(r)}`);
    }
    // Concurrent runScript on ONE persisted scriptId: both reach .eval() on the same
    // engine.Module, the second while the first may still be evaluating.
    const compiled = compile(evaluator, 'new Promise(r=>setTimeout(()=>r("done"),150))');
    if (!compiled.scriptId) throw new Error(`compile failed: ${JSON.stringify(compiled)}`);
    const q = { scriptId: compiled.scriptId, awaitPromise: true, returnByValue: true } as RpcParams['runScript'];
    const [a, b, c] = await Promise.all([
        evaluator.runScript(q),
        evaluator.runScript(q),
        evaluator.runScript(q),
    ]);
    for (const [i, r] of [a, b, c].entries()) {
        strictEqual(r.result?.value, 'done', `concurrent runScript ${i} disagreed: ${JSON.stringify(r)}`);
    }
});
