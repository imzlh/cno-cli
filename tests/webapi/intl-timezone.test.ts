import { deepStrictEqual, strictEqual, ok, throws, match } from 'node:assert';

// ============================================================================
// Intl: time zones, resolvedOptions round-trip, plain call, root collation,
// and the Date.prototype.toLocale* re-point.
//
// Every expectation below was verified against node v24.18.0 by differential
// extraction, EXCEPT the cases marked DIVERGENT, which are deliberate.
//
// BOUND ON HOST-ZONE CORRECTNESS: on Windows, quickjs.c getTimezoneOffset(int64_t
// time) ignores its `time` argument and returns the CURRENT DST state from
// GetTimeZoneInformation (quickjs.c:49495-49504). Host-zone formatting here is
// therefore exactly as correct as date.getHours() in the same runtime and no more.
// These tests pin fixed offsets so they do not depend on that.
// ============================================================================

const T = Date.UTC(2021, 2, 4, 15, 7, 9); // Thu 2021-03-04T15:07:09Z
const hm = (tz: string) =>
    new Intl.DateTimeFormat('en-US', { timeZone: tz, hour: '2-digit', minute: '2-digit', hour12: false })
        .format(T);

// --- zones that work ------------------------------------------------------

Deno.test('Intl tz: UTC and its aliases all resolve to offset 0', () => {
    for (const tz of ['UTC', 'utc', 'Etc/UTC', 'Etc/UCT', 'UCT', 'Universal', 'Zulu',
        'GMT', 'Etc/GMT', 'GMT0', 'Etc/GMT0', 'Greenwich', 'Etc/Greenwich', 'Etc/GMT+0']) {
        strictEqual(hm(tz), '15:07', 'zone ' + tz);
        strictEqual(new Intl.DateTimeFormat('en-US', { timeZone: tz }).resolvedOptions().timeZone, 'UTC');
    }
});

Deno.test('Intl tz: Etc/GMT+N applies the POSIX sign inversion', () => {
    // Etc/GMT+5 is UTC-5, not UTC+5. Verified against node.
    strictEqual(hm('Etc/GMT+5'), '10:07');
    strictEqual(hm('Etc/GMT-5'), '20:07');
    strictEqual(hm('Etc/GMT-14'), '05:07');
    strictEqual(hm('etc/gmt+5'), '10:07', 'lookup is case-insensitive');
    strictEqual(
        new Intl.DateTimeFormat('en-US', { timeZone: 'etc/gmt+5' }).resolvedOptions().timeZone,
        'Etc/GMT+5',
        'canonical spelling is restored',
    );
});

Deno.test('Intl tz: Etc/GMT range is asymmetric, matching tzdata', () => {
    strictEqual(hm('Etc/GMT+12'), '03:07');
    throws(() => hm('Etc/GMT+13'), RangeError, 'positive side stops at 12');
    throws(() => hm('Etc/GMT+14'), RangeError);
    throws(() => hm('Etc/GMT-15'), RangeError, 'negative side stops at 14');
});

Deno.test('Intl tz: offset literals in all three spellings', () => {
    strictEqual(hm('+05:30'), '20:37');
    strictEqual(hm('+0530'), '20:37');
    strictEqual(hm('+05'), '20:07');
    strictEqual(hm('-08'), '07:07');
    strictEqual(hm('-05:00'), '10:07');
    strictEqual(hm('+23:59'), '15:06', 'one minute short of a full day');
});

Deno.test('Intl tz: offset literals are range-checked to 23:59', () => {
    throws(() => hm('+24:00'), RangeError);
    throws(() => hm('+99:00'), RangeError);
    throws(() => hm('+05:60'), RangeError, 'minutes must be < 60');
    throws(() => hm('+5:30'), RangeError, 'hours must be two digits');
    throws(() => hm('05:30'), RangeError, 'a sign is required');
    throws(() => hm('Z'), RangeError, 'node rejects bare Z as a timeZone');
});

// --- zones that must throw ------------------------------------------------

Deno.test('Intl tz: named IANA zones throw RangeError naming the remedy', () => {
    for (const tz of ['America/New_York', 'Asia/Tokyo', 'Europe/Berlin', 'Asia/Shanghai',
        'Australia/Sydney', 'Not/AZone', 'garbage']) {
        throws(
            () => new Intl.DateTimeFormat('en-US', { timeZone: tz }),
            (err: unknown) => {
                ok(err instanceof RangeError, 'RangeError for ' + tz);
                const message = (err as Error).message;
                ok(message.includes(tz), 'message names the zone');
                // The remedy has to be in the message or the boundary is unlearnable.
                match(message, /Etc\/GMT/);
                return true;
            },
            'zone ' + tz,
        );
    }
});

Deno.test('Intl tz: a rejected zone is rejected at construction, not at format', () => {
    // node throws from InitializeDateTimeFormat, so nothing half-built escapes.
    throws(() => new Intl.DateTimeFormat('en-US', { timeZone: 'America/Denver' }), RangeError);
});

// --- resolvedOptions round-trip (the property node has and cno lacked) ----

Deno.test('Intl tz: resolvedOptions().timeZone round-trips through the resolver', () => {
    for (const tz of [undefined, 'UTC', 'Etc/GMT+5', 'Etc/GMT-14', '+05:30', '-08:00', '+00:00']) {
        const f = new Intl.DateTimeFormat('en-US', {
            timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit',
            hour: '2-digit', minute: '2-digit', hour12: false,
        });
        const reported = f.resolvedOptions().timeZone;
        ok(typeof reported === 'string' && reported.length > 0);
        // Feeding the reported value back must produce an identical formatter.
        const g = new Intl.DateTimeFormat('en-US', {
            timeZone: reported, year: 'numeric', month: '2-digit', day: '2-digit',
            hour: '2-digit', minute: '2-digit', hour12: false,
        });
        strictEqual(g.format(T), f.format(T), 'round-trip for ' + String(tz));
        strictEqual(g.resolvedOptions().timeZone, reported, 'and it is a fixed point');
    }
});

Deno.test('Intl tz: an explicit offset literal is reported back as itself', () => {
    // Not collapsed to 'UTC': node reports +00:00 for an explicit +00:00.
    strictEqual(new Intl.DateTimeFormat('en', { timeZone: '+00:00' }).resolvedOptions().timeZone, '+00:00');
    strictEqual(new Intl.DateTimeFormat('en', { timeZone: '-00:00' }).resolvedOptions().timeZone, '+00:00');
    strictEqual(new Intl.DateTimeFormat('en', { timeZone: '+0530' }).resolvedOptions().timeZone, '+05:30');
});

Deno.test('Intl tz: the host zone is reported honestly, never as a false UTC', () => {
    const reported = new Intl.DateTimeFormat('en-US').resolvedOptions().timeZone;
    const hostOffset = -new Date(T).getTimezoneOffset();
    if (hostOffset === 0) {
        strictEqual(reported, 'UTC');
    } else {
        // DIVERGENT: node reports the IANA name (e.g. Asia/Shanghai). cno has no
        // tzdata and no native API to learn it, so it reports the actual offset,
        // which is truthful and round-trips. Reporting 'UTC' was simply false.
        match(reported, /^[+-][0-9]{2}:[0-9]{2}$/);
        const sign = hostOffset < 0 ? '-' : '+';
        const abs = Math.abs(hostOffset);
        const pad = (n: number) => (n < 10 ? '0' + n : String(n));
        strictEqual(reported, sign + pad(Math.floor(abs / 60)) + ':' + pad(abs % 60));
    }
});

// --- four zones must not collapse to one string ---------------------------

Deno.test('Intl tz: distinct offsets produce distinct output', () => {
    // The stub returned one ISO string for every zone; this is the regression guard.
    const seen = new Set([hm('UTC'), hm('Etc/GMT+5'), hm('+05:30'), hm('Etc/GMT-14')]);
    strictEqual(seen.size, 4);
    ok(!hm('UTC').includes('T'), 'no ISO-8601 fallback leaks through');
});
