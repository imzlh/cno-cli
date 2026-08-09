/**
 * `node:timers/promises` rejects with a real `AbortError` CLASS, not a plain
 * Error stamped with `name = 'AbortError'`.
 *
 * Measured on Node v24.18.0 (/d/tmp/ag-timers/p19-aborterr.cjs, both abort
 * shapes -- default reason and an explicit `ac.abort(new RangeError(...))`):
 *
 *     err.name                                    AbortError
 *     err.code                                    ABORT_ERR
 *     err.constructor.name                        AbortError
 *     Object.getPrototypeOf(err).constructor.name AbortError
 *     err.message                                 The operation was aborted
 *     Object.getOwnPropertyNames(err).sort()      cause,code,message,name,stack
 *     err instanceof Error                        true
 *     err instanceof DOMException                 false
 *
 * cno previously built the rejection with
 * `Object.assign(new Error('The operation was aborted'), { name, code })`, which
 * reproduced every cell above EXCEPT the two constructor cells -- both reported
 * plain `Error`. `.name` and `.code` matched, so a `.name`-based check passed and
 * the divergence stayed invisible; only code that brands errors by CONSTRUCTOR
 * (common in retry / cancellation wrappers, and in `instanceof`-style helpers
 * exported by userland abort libraries) saw the wrong class.
 *
 * The constructor assertions below are the load-bearing ones: they are what a
 * plain `Object.assign(new Error(...))` cannot satisfy. `name`/`code` are
 * asserted as OWN properties because subclassing via a class field declaration
 * rather than an assignment would move them onto the prototype and silently
 * change `Object.getOwnPropertyNames`, which Node reports as own.
 */
import { ok, strictEqual, deepStrictEqual } from 'node:assert';
import * as timersPromises from 'node:timers/promises';

/** Aborts a pending `timers/promises.setTimeout` and returns the rejection. */
async function abortedRejection(reason?: unknown): Promise<Error & Record<string, unknown>> {
    const ac = new AbortController();
    // 30_000ms so only the abort can settle it -- never the delay itself.
    const pending = timersPromises.setTimeout(30_000, 'unused', { signal: ac.signal });
    if (reason === undefined) ac.abort();
    else ac.abort(reason);
    try {
        await pending;
    } catch (err) {
        return err as Error & Record<string, unknown>;
    }
    throw new Error('timers/promises.setTimeout resolved instead of rejecting on abort');
}

Deno.test('timers/promises: abort rejects with a real AbortError class, not a stamped Error', async () => {
    const err = await abortedRejection();

    // The two cells a plain `Object.assign(new Error(...))` gets wrong.
    strictEqual(err.constructor.name, 'AbortError', 'err.constructor.name');
    strictEqual(
        Object.getPrototypeOf(err).constructor.name,
        'AbortError',
        'Object.getPrototypeOf(err).constructor.name',
    );
});

Deno.test('timers/promises: AbortError keeps the rest of Node\'s error shape', async () => {
    const err = await abortedRejection();

    strictEqual(err.name, 'AbortError', 'err.name');
    strictEqual(err.code, 'ABORT_ERR', 'err.code');
    strictEqual(err.message, 'The operation was aborted', 'err.message');
    strictEqual(String(err), 'AbortError: The operation was aborted', 'String(err)');
    ok(err instanceof Error, 'err instanceof Error');

    // Node's AbortError is NOT a DOMException here (measured false on v24.18.0).
    if (typeof DOMException !== 'undefined') {
        strictEqual(err instanceof DOMException, false, 'err instanceof DOMException');
    }

    // Node reports all five as OWN properties. A class-field declaration instead
    // of a constructor assignment would drop `name`/`code` from this list.
    deepStrictEqual(
        Object.getOwnPropertyNames(err).sort(),
        ['cause', 'code', 'message', 'name', 'stack'],
        'Object.getOwnPropertyNames(err).sort()',
    );
});

Deno.test('timers/promises: an explicit abort reason lands on .cause and does not change the class', async () => {
    const reason = new RangeError('explicit-reason');
    const err = await abortedRejection(reason);

    // Node deliberately does NOT surface the reason as the rejection itself --
    // it stays the generic AbortError and the reason goes to `cause`.
    strictEqual(err.constructor.name, 'AbortError', 'err.constructor.name with a reason');
    strictEqual(err.name, 'AbortError', 'err.name with a reason');
    strictEqual(err.code, 'ABORT_ERR', 'err.code with a reason');
    strictEqual(err.message, 'The operation was aborted', 'err.message with a reason');
    strictEqual(err.cause, reason, 'err.cause is the reason object, by identity');
});

Deno.test('timers/promises: an already-aborted signal rejects with the same AbortError class', async () => {
    // Different code path in cno/src/node/timers/mod.ts: the pre-aborted branch
    // returns Promise.reject(createAbortError(...)) directly instead of going
    // through the signal's 'abort' listener.
    try {
        await timersPromises.setTimeout(30_000, 'unused', { signal: AbortSignal.abort() });
        throw new Error('a pre-aborted signal resolved instead of rejecting');
    } catch (e) {
        const err = e as Error & Record<string, unknown>;
        strictEqual(err.constructor.name, 'AbortError', 'pre-aborted err.constructor.name');
        strictEqual(err.name, 'AbortError', 'pre-aborted err.name');
        strictEqual(err.code, 'ABORT_ERR', 'pre-aborted err.code');
    }
});

Deno.test('timers/promises: setImmediate and setInterval abort with the same AbortError class', async () => {
    // Both share createAbortError, so a regression in one is a regression in all.
    try {
        await timersPromises.setImmediate('unused', { signal: AbortSignal.abort() });
        throw new Error('setImmediate resolved on a pre-aborted signal');
    } catch (e) {
        strictEqual((e as Error).constructor.name, 'AbortError', 'setImmediate err.constructor.name');
    }

    try {
        // eslint-disable-next-line no-unused-vars
        for await (const _ of timersPromises.setInterval(30_000, 'unused', { signal: AbortSignal.abort() })) {
            throw new Error('setInterval yielded on a pre-aborted signal');
        }
        throw new Error('setInterval ended without rejecting on a pre-aborted signal');
    } catch (e) {
        strictEqual((e as Error).constructor.name, 'AbortError', 'setInterval err.constructor.name');
    }
});
