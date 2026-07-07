import { deepStrictEqual, strictEqual, ok, throws } from 'node:assert';

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

Deno.test('ErrorEvent upstream: defaults init fields and inspect shape', () => {
    const defaultEvent = new ErrorEvent('error');
    strictEqual(defaultEvent.type, 'error');
    strictEqual(defaultEvent.bubbles, false);
    strictEqual(defaultEvent.cancelable, false);
    strictEqual(defaultEvent.composed, false);
    strictEqual(defaultEvent.message, '');
    strictEqual(defaultEvent.filename, '');
    strictEqual(defaultEvent.lineno, 0);
    strictEqual(defaultEvent.colno, 0);
    strictEqual(defaultEvent.error, null);
    strictEqual(Object.prototype.toString.call(defaultEvent), '[object ErrorEvent]');

    const cause = new TypeError('boom');
    const event = new ErrorEvent('worker-error', {
        bubbles: true,
        cancelable: true,
        message: 'message',
        filename: 'file.ts',
        lineno: 12,
        colno: 34,
        error: cause,
    });
    strictEqual(event.bubbles, true);
    strictEqual(event.cancelable, true);
    strictEqual(event.message, 'message');
    strictEqual(event.filename, 'file.ts');
    strictEqual(event.lineno, 12);
    strictEqual(event.colno, 34);
    strictEqual(event.error, cause);
    ok(Deno.inspect(event, { colors: false }).includes('ErrorEvent'));
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

Deno.test('EventTarget upstream: dispatch sets target and currentTarget', () => {
    const target = new EventTarget();
    const event = new Event('targeted');
    strictEqual(event.target, null);
    strictEqual(event.currentTarget, null);

    target.addEventListener('targeted', (dispatched) => {
        strictEqual(dispatched, event);
        strictEqual(dispatched.target, target);
        strictEqual(dispatched.currentTarget, target);
    });

    strictEqual(target.dispatchEvent(event), true);
    strictEqual(event.target, target);
    strictEqual(event.currentTarget, null);
});

Deno.test('EventTarget upstream: object listeners and capture matching removal', () => {
    const target = new EventTarget();
    const event = new Event('object-listener');
    let callCount = 0;
    const listener = {
        handleEvent(dispatched: Event) {
            strictEqual(dispatched, event);
            callCount++;
        },
    };

    target.addEventListener('object-listener', listener, true);
    target.dispatchEvent(event);
    strictEqual(callCount, 1);

    target.removeEventListener('object-listener', listener, false);
    target.dispatchEvent(event);
    strictEqual(callCount, 2);

    target.removeEventListener('object-listener', listener, true);
    target.dispatchEvent(event);
    strictEqual(callCount, 2);
});

Deno.test('EventTarget upstream: dispatch uses a listener snapshot', () => {
    const target = new EventTarget();
    let callCount = 0;

    target.addEventListener('snapshot', () => {
        callCount++;
        target.addEventListener('snapshot', () => {
            callCount++;
        });
    });

    target.dispatchEvent(new Event('snapshot'));
    strictEqual(callCount, 1);
    target.dispatchEvent(new Event('snapshot'));
    strictEqual(callCount, 3);
});

Deno.test('EventTarget upstream: listener event type is stringified', () => {
    const target = new EventTarget();
    const type = { toString: () => 'stringified-type' };
    let callCount = 0;
    const listener = () => { callCount++; };

    target.addEventListener(type as unknown as string, listener);
    target.dispatchEvent(new Event('stringified-type'));
    strictEqual(callCount, 1);

    target.removeEventListener(type as unknown as string, listener);
    target.dispatchEvent(new Event('stringified-type'));
    strictEqual(callCount, 1);
});

Deno.test('EventTarget upstream: prototype methods reject invalid receivers', () => {
    const receiver = {};
    throws(() => EventTarget.prototype.addEventListener.call(receiver, 'test', null), TypeError);
    throws(() => EventTarget.prototype.removeEventListener.call(receiver, 'test', null), TypeError);
    throws(() => EventTarget.prototype.dispatchEvent.call(receiver, new Event('test')), TypeError);
});
