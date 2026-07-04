import { strictEqual, ok } from 'node:assert';
import * as dc from 'node:diagnostics_channel';

// --- 1. channel() returns a Channel -----------------------------------------

Deno.test('diagnostics_channel: channel returns Channel', () => {
    const ch = dc.channel('test.ch');
    ok(ch);
    ok(typeof ch.subscribe === 'function');
    ok(typeof ch.unsubscribe === 'function');
    ok(typeof ch.hasSubscribers === 'function');
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
    const sub = ch.subscribe(() => {});
    ok(ch.hasSubscribers(), 'must have subscribers after subscribe');
    sub.unsubscribe();
    ok(!dc.hasSubscribers('sub.ch'), 'must not have subscribers after unsubscribe');
});

// --- 4. hasSubscribers for unknown channel is false ------------------------

Deno.test('diagnostics_channel: hasSubscribers false for unknown', () => {
    ok(!dc.hasSubscribers('no.such.channel.xyz'));
});

// --- 5. subscribe returns an object with unsubscribe -----------------------

Deno.test('diagnostics_channel: subscribe returns unsubscribe handle', () => {
    const ch = dc.channel('handle.ch');
    const handle = ch.subscribe(() => {});
    ok(typeof handle.unsubscribe === 'function');
    handle.unsubscribe();
    ch.unsubscribe(() => {}); // safe even if not subscribed
});

// --- 6. channel name is stored ----------------------------------------------

Deno.test('diagnostics_channel: Channel has name', () => {
    const ch = dc.channel('named.ch');
    ok(ch.name === 'named.ch' || (ch as any)._name === 'named.ch');
});

// --- 7. unsubscribe non-subscriber is safe ---------------------------------

Deno.test('diagnostics_channel: unsubscribe non-subscriber is safe', () => {
    const ch = dc.channel('safe.ch');
    ch.unsubscribe(() => {}); // never subscribed — must not throw
    ok(true);
});

// --- 8. multiple subscribers all tracked -----------------------------------

Deno.test('diagnostics_channel: multiple subscribers tracked', () => {
    const ch = dc.channel('multi.ch');
    const s1 = ch.subscribe(() => {});
    const s2 = ch.subscribe(() => {});
    ok(ch.hasSubscribers());
    s1.unsubscribe();
    ok(ch.hasSubscribers(), 'still has one subscriber');
    s2.unsubscribe();
    ok(!ch.hasSubscribers(), 'no subscribers after all unsubscribed');
});
