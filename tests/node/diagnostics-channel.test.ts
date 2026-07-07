import { deepStrictEqual, strictEqual, ok, throws } from 'node:assert';
import * as dc from 'node:diagnostics_channel';

// --- 1. channel() returns a Channel -----------------------------------------

Deno.test('diagnostics_channel: channel returns Channel', () => {
    const ch = dc.channel('test.ch');
    ok(ch);
    strictEqual(typeof ch.publish, 'function');
    ok(typeof ch.subscribe === 'function');
    ok(typeof ch.unsubscribe === 'function');
    strictEqual(typeof ch.hasSubscribers, 'boolean');
});

// --- 2. same name returns same channel (singleton) -------------------------

Deno.test('diagnostics_channel: same name returns same channel', () => {
    const a = dc.channel('singleton.ch');
    const b = dc.channel('singleton.ch');
    strictEqual(a, b, 'channel must be a singleton per name');
});

// --- 3. subscribe then hasSubscribers returns true -------------------------

Deno.test('diagnostics_channel: subscribe then hasSubscribers true', () => {
    const ch = dc.channel('sub.ch');
    const fn = () => {};
    strictEqual(ch.subscribe(fn), undefined);
    ok(ch.hasSubscribers, 'must have subscribers after subscribe');
    ch.unsubscribe(fn);
    ok(!dc.hasSubscribers('sub.ch'), 'must not have subscribers after unsubscribe');
});

// --- 4. hasSubscribers for unknown channel is false ------------------------

Deno.test('diagnostics_channel: hasSubscribers false for unknown', () => {
    ok(!dc.hasSubscribers('no.such.channel.xyz'));
});

// --- 5. publish delivers message and channel name to each subscriber -------

Deno.test('diagnostics_channel: publish notifies subscribers in subscription order', () => {
    const ch = dc.channel('publish.ch');
    const seen: Array<[string, unknown, string | symbol]> = [];
    const a = (message: unknown, name: string | symbol) => seen.push(['a', message, name]);
    const b = (message: unknown, name: string | symbol) => seen.push(['b', message, name]);

    ch.subscribe(a);
    ch.subscribe(b);
    strictEqual(ch.publish({ ok: true }), undefined);
    ch.unsubscribe(a);
    ch.unsubscribe(b);

    deepStrictEqual(seen, [
        ['a', { ok: true }, 'publish.ch'],
        ['b', { ok: true }, 'publish.ch'],
    ]);
});

// --- 6. channel name is stored ----------------------------------------------

Deno.test('diagnostics_channel: Channel has name', () => {
    const ch = dc.channel('named.ch');
    ok(ch.name === 'named.ch' || (ch as any)._name === 'named.ch');
});

// --- 7. unsubscribe non-subscriber is safe ---------------------------------

Deno.test('diagnostics_channel: unsubscribe non-subscriber is safe', () => {
    const ch = dc.channel('safe.ch');
    strictEqual(ch.unsubscribe(() => {}), false);
});

// --- 8. top-level subscribe/unsubscribe pair works -------------------------

Deno.test('diagnostics_channel: top-level subscribe/unsubscribe uses named channel', () => {
    const seen: Array<string | symbol> = [];
    const fn = (_message: unknown, name: string | symbol) => seen.push(name);

    strictEqual(dc.subscribe('named-sub.ch', fn), undefined);
    ok(dc.hasSubscribers('named-sub.ch'));
    dc.channel('named-sub.ch').publish('payload');
    strictEqual(dc.unsubscribe('named-sub.ch', fn), true);

    deepStrictEqual(seen, ['named-sub.ch']);
    ok(!dc.hasSubscribers('named-sub.ch'));
});

Deno.test('diagnostics_channel: top-level unsubscribe reports false for missing handler', () => {
    strictEqual(dc.unsubscribe('missing-unsub.ch', () => {}), false);
});

Deno.test('diagnostics_channel: symbol channel names are preserved', () => {
    const name = Symbol('symbol.ch');
    const ch = dc.channel(name);
    const seen: Array<string | symbol> = [];
    const fn = (_message: unknown, channelName: string | symbol) => seen.push(channelName);

    strictEqual(dc.channel(name), ch);
    strictEqual(ch.name, name);
    ch.subscribe(fn);
    ch.publish('payload');
    strictEqual(ch.unsubscribe(fn), true);
    deepStrictEqual(seen, [name]);
});

Deno.test('diagnostics_channel: invalid channel names are rejected where Node rejects them', () => {
    const invalid = 123 as unknown as string;
    strictEqual(dc.hasSubscribers(invalid), false);
    throws(() => dc.channel(invalid), TypeError);
    throws(() => dc.subscribe(invalid, () => {}), TypeError);
    throws(() => dc.unsubscribe(invalid, () => {}), TypeError);
});

Deno.test('diagnostics_channel: subscribe requires a function', () => {
    throws(() => {
        dc.channel('bad-subscription.ch').subscribe(123 as unknown as () => void);
    }, TypeError);
});

// --- 9. tracingChannel exposes phase channels with stable names ------------

Deno.test('diagnostics_channel: tracingChannel exposes the five tracing phases', () => {
    const trace = dc.tracingChannel('work');
    const names = [
        trace.start.name,
        trace.end.name,
        trace.asyncStart.name,
        trace.asyncEnd.name,
        trace.error.name,
    ];

    deepStrictEqual(names, [
        'tracing:work:start',
        'tracing:work:end',
        'tracing:work:asyncStart',
        'tracing:work:asyncEnd',
        'tracing:work:error',
    ]);
});

Deno.test('diagnostics_channel: tracingChannel starts without subscribers', () => {
    const trace = dc.tracingChannel('work-empty');
    strictEqual(trace.hasSubscribers, false);
    strictEqual(trace.start.hasSubscribers, false);
    strictEqual(trace.end.hasSubscribers, false);
});

// --- 10. multiple subscribers all tracked ----------------------------------

Deno.test('diagnostics_channel: multiple subscribers tracked', () => {
    const ch = dc.channel('multi.ch');
    const fn1 = () => {};
    const fn2 = () => {};
    ch.subscribe(fn1);
    ch.subscribe(fn2);
    ok(ch.hasSubscribers);
    strictEqual(ch.unsubscribe(fn1), true);
    ok(ch.hasSubscribers, 'still has one subscriber');
    strictEqual(ch.unsubscribe(fn2), true);
    ok(!ch.hasSubscribers, 'no subscribers after all unsubscribed');
});

Deno.test('diagnostics_channel: duplicate subscriber is removed one subscription at a time', () => {
    const ch = dc.channel('dup.ch');
    const seen: string[] = [];
    const fn = () => seen.push('fn');
    ch.subscribe(fn);
    ch.subscribe(fn);

    strictEqual(ch.unsubscribe(fn), true);
    ok(ch.hasSubscribers);
    ch.publish('payload');
    strictEqual(ch.unsubscribe(fn), true);
    ok(!ch.hasSubscribers);
    deepStrictEqual(seen, ['fn']);
});

Deno.test('diagnostics_channel: tracingChannel subscribe and unsubscribe handlers', () => {
    const trace = dc.tracingChannel('sub-unsub');
    const seen: string[] = [];
    const handlers = {
        start: () => seen.push('start'),
        end: () => seen.push('end'),
    };

    trace.subscribe(handlers);
    ok(trace.hasSubscribers);
    trace.traceSync(() => 'ok');
    strictEqual(trace.unsubscribe(handlers), true);
    ok(!trace.hasSubscribers);
    deepStrictEqual(seen, ['start', 'end']);
});

Deno.test('diagnostics_channel: tracingChannel traceSync publishes result context', () => {
    const trace = dc.tracingChannel('sync');
    const seen: Array<[string, unknown]> = [];
    const onStart = (message: unknown) => seen.push(['start', (message as { result?: unknown }).result]);
    const onEnd = (message: unknown) => seen.push(['end', (message as { result?: unknown }).result]);
    trace.start.subscribe(onStart);
    trace.end.subscribe(onEnd);

    try {
        strictEqual(trace.traceSync((a: number, b: number) => a + b, {}, undefined, 2, 3), 5);
        deepStrictEqual(seen, [['start', undefined], ['end', 5]]);
    } finally {
        trace.start.unsubscribe(onStart);
        trace.end.unsubscribe(onEnd);
    }
});

Deno.test('diagnostics_channel: tracingChannel tracePromise publishes async phases', async () => {
    const trace = dc.tracingChannel('promise');
    const seen: Array<[string, unknown]> = [];
    const onStart = () => seen.push(['start', undefined]);
    const onEnd = () => seen.push(['end', undefined]);
    const onAsyncStart = (message: unknown) => seen.push(['asyncStart', (message as { result?: unknown }).result]);
    const onAsyncEnd = (message: unknown) => seen.push(['asyncEnd', (message as { result?: unknown }).result]);
    trace.start.subscribe(onStart);
    trace.end.subscribe(onEnd);
    trace.asyncStart.subscribe(onAsyncStart);
    trace.asyncEnd.subscribe(onAsyncEnd);

    try {
        strictEqual(await trace.tracePromise(async (value: number) => value * 2, {}, undefined, 4), 8);
        deepStrictEqual(seen, [['start', undefined], ['end', undefined], ['asyncStart', 8], ['asyncEnd', 8]]);
    } finally {
        trace.start.unsubscribe(onStart);
        trace.end.unsubscribe(onEnd);
        trace.asyncStart.unsubscribe(onAsyncStart);
        trace.asyncEnd.unsubscribe(onAsyncEnd);
    }
});

Deno.test('diagnostics_channel: tracingChannel traceCallback wraps callback result', async () => {
    const trace = dc.tracingChannel('callback');
    const seen: Array<[string, unknown]> = [];
    const onStart = () => seen.push(['start', undefined]);
    const onEnd = () => seen.push(['end', undefined]);
    const onAsyncStart = (message: unknown) => seen.push(['asyncStart', (message as { result?: unknown }).result]);
    const onAsyncEnd = (message: unknown) => seen.push(['asyncEnd', (message as { result?: unknown }).result]);
    trace.start.subscribe(onStart);
    trace.end.subscribe(onEnd);
    trace.asyncStart.subscribe(onAsyncStart);
    trace.asyncEnd.subscribe(onAsyncEnd);

    try {
        const result = await new Promise<string>((resolve, reject) => {
            trace.traceCallback((callback: (error: Error | null, value: string) => void) => {
                callback(null, 'done');
            }, -1, {}, undefined, (error: Error | null, value: string) => {
                if (error) reject(error);
                else resolve(value);
            });
        });
        strictEqual(result, 'done');
        deepStrictEqual(seen, [['start', undefined], ['asyncStart', 'done'], ['asyncEnd', 'done'], ['end', undefined]]);
    } finally {
        trace.start.unsubscribe(onStart);
        trace.end.unsubscribe(onEnd);
        trace.asyncStart.unsubscribe(onAsyncStart);
        trace.asyncEnd.unsubscribe(onAsyncEnd);
    }
});
