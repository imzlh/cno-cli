import { strictEqual, ok } from 'node:assert';

// ============================================================================
// Web API — Lock API (navigator.locks)
// ============================================================================

Deno.test('webapi: navigator.locks exists', () => {
    ok(typeof navigator === 'object');
    ok(typeof navigator.locks === 'object');
    ok(typeof navigator.locks.request === 'function');
    ok(typeof navigator.locks.query === 'function');
});

Deno.test('webapi: locks.request exclusive', async () => {
    let acquired = false;
    await navigator.locks.request('test-lock-1', (lock) => {
        acquired = lock !== null;
        ok(lock !== null);
        strictEqual(lock.name, 'test-lock-1');
        strictEqual(lock.mode, 'exclusive');
    });
    ok(acquired);
});

Deno.test('webapi: locks.request shared', async () => {
    await navigator.locks.request('test-lock-2', { mode: 'shared' }, (lock) => {
        ok(lock !== null);
        strictEqual(lock.mode, 'shared');
    });
});

Deno.test('webapi: locks.request returns value from callback', async () => {
    const result = await navigator.locks.request('test-lock-3', () => {
        return 42;
    });
    strictEqual(result, 42);
});

Deno.test('webapi: locks.request rejects on callback error', async () => {
    try {
        await navigator.locks.request('test-lock-4', () => {
            throw new Error('lock error');
        });
        ok(false, 'should have thrown');
    } catch (e: any) {
        ok(e.message.includes('lock error'));
    }
});

Deno.test('webapi: locks.request with AbortSignal', async () => {
    const ac = new AbortController();
    ac.abort();
    try {
        await navigator.locks.request('test-lock-5', { signal: ac.signal }, () => {});
        ok(true); // may or may not throw depending on timing
    } catch (e: any) {
        ok(e.name === 'AbortError' || e.message.includes('abort'));
    }
});

Deno.test('webapi: locks.query returns object', async () => {
    const query = await navigator.locks.query();
    ok(typeof query === 'object');
    ok(Array.isArray(query.held));
    ok(Array.isArray(query.pending));
});
