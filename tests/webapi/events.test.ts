import { strictEqual, ok } from 'node:assert';

// ============================================================================
// Event / EventTarget / CustomEvent
// ============================================================================

// --- 1. EventTarget add + remove + dispatch -------------------------------

Deno.test('EventTarget: add/dispatch/remove listener', () => {
    const et = new EventTarget();
    let count = 0;
    const fn = () => { count++; };
    et.addEventListener('e', fn);
    et.dispatchEvent(new Event('e'));
    strictEqual(count, 1);
    et.removeEventListener('e', fn);
    et.dispatchEvent(new Event('e'));
    strictEqual(count, 1, 'removed listener must not fire');
});

// --- 2. addEventListener with options.once -------------------------------

Deno.test('EventTarget: once listener fires once', () => {
    const et = new EventTarget();
    let count = 0;
    et.addEventListener('e', () => { count++; }, { once: true });
    et.dispatchEvent(new Event('e'));
    et.dispatchEvent(new Event('e'));
    strictEqual(count, 1);
});

// --- 3. addEventListener with options.signal (AbortSignal) ----------------

Deno.test('AbortSignal removes listener on abort', () => {
    const et = new EventTarget();
    const ac = new AbortController();
    let count = 0;
    et.addEventListener('e', () => { count++; }, { signal: ac.signal });
    et.dispatchEvent(new Event('e'));
    strictEqual(count, 1);
    ac.abort();
    et.dispatchEvent(new Event('e'));
    strictEqual(count, 1, 'aborted listener must not fire');
});

// --- 4. Event: type, bubbles, cancelable, composed -----------------------

Deno.test('Event: type and flags', () => {
    const e = new Event('click', { bubbles: true, cancelable: true, composed: true });
    strictEqual(e.type, 'click');
    ok(e.bubbles);
    ok(e.cancelable);
    ok(e.composed);
});

// --- 5. Event preventDefault only works when cancelable --------------------

Deno.test('Event: preventDefault only when cancelable', () => {
    const e1 = new Event('x', { cancelable: true });
    e1.preventDefault();
    ok(e1.defaultPrevented);

    const e2 = new Event('x', { cancelable: false });
    let threw = false;
    try { e2.preventDefault(); } catch { threw = true; }
    // Node: preventDefault on non-cancelable is a no-op, does not throw
    ok(!e2.defaultPrevented);
});

// --- 6. Event stopPropagation --------------------------------------------
// deprecated

// --- 7. CustomEvent: detail payload --------------------------------------

Deno.test('CustomEvent: carries detail', () => {
    const e = new CustomEvent('build', { detail: { status: 'ok' } });
    strictEqual(e.type, 'build');
    strictEqual(e.detail.status, 'ok');
});

// --- 8. Event static phase constants -------------------------------------

Deno.test('Event phase constants', () => {
    strictEqual(Event.NONE, 0);
    strictEqual(Event.CAPTURING_PHASE, 1);
    strictEqual(Event.AT_TARGET, 2);
    strictEqual(Event.BUBBLING_PHASE, 3);
});

// --- 9. Event eventPhase is NONE before dispatch -------------------------

Deno.test('Event: eventPhase is NONE initially', () => {
    const e = new Event('x');
    strictEqual(e.eventPhase, Event.NONE);
});

// --- 10. Event timeStamp is a number -------------------------------------

Deno.test('Event: timeStamp is a number', () => {
    const e = new Event('x');
    ok(typeof e.timeStamp === 'number' && e.timeStamp >= 0);
});

// --- 11. removeEventListener with non-matching fn is no-op ---------------

Deno.test('EventTarget: remove non-added listener is no-op', () => {
    const et = new EventTarget();
    et.removeEventListener('e', () => {});
    ok(true); // no throw
});

// --- 12. multiple listeners fire in order --------------------------------

Deno.test('EventTarget: listeners fire in registration order', () => {
    const et = new EventTarget();
    const order: number[] = [];
    et.addEventListener('e', () => order.push(1));
    et.addEventListener('e', () => order.push(2));
    et.addEventListener('e', () => order.push(3));
    et.dispatchEvent(new Event('e'));
    deepStrictEqual(order, [1, 2, 3]);
});

function deepStrictEqual(a: unknown, b: unknown) {
    strictEqual(JSON.stringify(a), JSON.stringify(b));
}
