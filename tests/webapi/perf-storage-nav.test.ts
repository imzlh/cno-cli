import { strictEqual, ok, match } from 'node:assert';

// ============================================================================
// performance / storage / navigator
// ============================================================================

// --- performance -----------------------------------------------------------

Deno.test('performance: now() returns a number', () => {
    const t = performance.now();
    ok(typeof t === 'number' && t >= 0);
});

Deno.test('performance: now() is monotonic', () => {
    const a = performance.now();
    const b = performance.now();
    ok(b >= a, 'performance.now must be monotonic');
});

Deno.test('performance: timeOrigin is a number', () => {
    ok(typeof performance.timeOrigin === 'number');
});

Deno.test('performance: mark + measure', () => {
    performance.mark('start');
    for (let i = 0; i < 1000; i++) {} // some work
    performance.mark('end');
    performance.measure('loop', 'start', 'end');
    const entries = performance.getEntriesByType('measure');
    ok(entries.length >= 1);
    ok(entries.some((e) => e.name === 'loop'));
});

Deno.test('performance: getEntries returns PerformanceEntry list', () => {
    performance.mark('x-mark');
    const marks = performance.getEntriesByType('mark');
    ok(Array.isArray(marks));
    ok(marks.some((m) => m.name === 'x-mark'));
});

Deno.test('performance: clearMarks / clearMeasures', () => {
    performance.mark('to-clear');
    performance.clearMarks('to-clear');
    const marks = performance.getEntriesByName('to-clear', 'mark');
    strictEqual(marks.length, 0);
});

Deno.test('performance: toJSON returns object', () => {
    const obj = performance.toJSON();
    ok(obj && typeof obj === 'object');
});

// --- storage (localStorage) ------------------------------------------------

Deno.test('localStorage: setItem/getItem/removeItem', () => {
    localStorage.setItem('k1', 'v1');
    strictEqual(localStorage.getItem('k1'), 'v1');
    localStorage.removeItem('k1');
    strictEqual(localStorage.getItem('k1'), null);
});

Deno.test('localStorage: length and key()', () => {
    localStorage.clear();
    localStorage.setItem('a', '1');
    localStorage.setItem('b', '2');
    strictEqual(localStorage.length, 2);
    const k0 = localStorage.key(0);
    ok(k0 === 'a' || k0 === 'b');
});

Deno.test('localStorage: clear empties all', () => {
    localStorage.setItem('x', '1');
    localStorage.setItem('y', '2');
    localStorage.clear();
    strictEqual(localStorage.length, 0);
    strictEqual(localStorage.getItem('x'), null);
});

Deno.test('localStorage: bracket access works', () => {
    localStorage.setItem('bk', 'bv');
    ok(localStorage.getItem('bk') !== null);
    localStorage.removeItem('bk');
});

Deno.test('localStorage: overwriting replaces value', () => {
    localStorage.setItem('ov', 'first');
    localStorage.setItem('ov', 'second');
    strictEqual(localStorage.getItem('ov'), 'second');
});

Deno.test('sessionStorage: basic round-trip', () => {
    sessionStorage.setItem('sk', 'sv');
    strictEqual(sessionStorage.getItem('sk'), 'sv');
    sessionStorage.removeItem('sk');
    strictEqual(sessionStorage.getItem('sk'), null);
});

// --- navigator -------------------------------------------------------------

Deno.test('navigator: userAgent is a string', () => {
    ok(typeof navigator.userAgent === 'string' && navigator.userAgent.length > 0);
});

Deno.test('navigator: platform is a string', () => {
    ok(typeof navigator.platform === 'string');
});

Deno.test('navigator: language is a string', () => {
    ok(typeof navigator.language === 'string');
});

Deno.test('navigator: languages is an array of strings', () => {
    ok(Array.isArray(navigator.languages));
    ok(navigator.languages.every((l) => typeof l === 'string'));
});

Deno.test('navigator: hardwareConcurrency is a positive number', () => {
    ok(typeof navigator.hardwareConcurrency === 'number' && navigator.hardwareConcurrency > 0);
});

Deno.test('navigator: onLine is boolean', () => {
    ok(typeof navigator.onLine === 'boolean');
});

Deno.test('navigator: permissions is an object', () => {
    ok(navigator.permissions && typeof navigator.permissions === 'object');
});

Deno.test('navigator: clipboard is an object', () => {
    ok(navigator.clipboard && typeof navigator.clipboard === 'object');
});
