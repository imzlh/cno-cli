import { strictEqual, ok, match } from 'node:assert';

// ============================================================================
// Intl — DateTimeFormat / NumberFormat / Collator / PluralRules / DisplayNames
// ============================================================================

// --- DateTimeFormat -------------------------------------------------------

Deno.test('Intl.DateTimeFormat: formats a date', () => {
    const f = new Intl.DateTimeFormat('en-US');
    const s = f.format(new Date(2020, 0, 2));
    ok(typeof s === 'string' && s.length > 0);
});

Deno.test('Intl.DateTimeFormat: formatToParts returns parts array', () => {
    const f = new Intl.DateTimeFormat('en-US');
    const parts = f.formatToParts(new Date(2020, 0, 2));
    ok(Array.isArray(parts));
    ok(parts.length > 0);
    ok(parts.every((p) => 'type' in p && 'value' in p));
});

Deno.test('Intl.DateTimeFormat: options affect output', () => {
    const f = new Intl.DateTimeFormat('en-US', { year: 'numeric', month: 'long' });
    const s = f.format(new Date(2020, 0, 2));
    ok(s.includes('January'));
});

Deno.test('Intl.DateTimeFormat: resolvedOptions returns config', () => {
    const f = new Intl.DateTimeFormat('en-US', { dateStyle: 'full' });
    const o = f.resolvedOptions();
    ok(typeof o === 'object');
    ok(o.locale === 'en-US');
});

Deno.test('Intl.DateTimeFormat: formatRange', () => {
    const f = new Intl.DateTimeFormat('en-US');
    const s = f.formatRange(new Date(2020, 0, 1), new Date(2020, 0, 2));
    ok(typeof s === 'string' && s.length > 0);
});

// --- NumberFormat ---------------------------------------------------------

Deno.test('Intl.NumberFormat: formats number', () => {
    const f = new Intl.NumberFormat('en-US');
    const s = f.format(1234567.89);
    ok(typeof s === 'string' && s.length > 0);
    ok(s.includes('1'));
});

Deno.test('Intl.NumberFormat: style currency', () => {
    const f = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' });
    const s = f.format(42);
    ok(typeof s === 'string');
});

Deno.test('Intl.NumberFormat: style percent', () => {
    const f = new Intl.NumberFormat('en-US', { style: 'percent' });
    const s = f.format(0.5);
    ok(s.includes('%'));
});

Deno.test('Intl.NumberFormat: formatToParts', () => {
    const f = new Intl.NumberFormat('en-US');
    const parts = f.formatToParts(1234);
    ok(Array.isArray(parts));
    ok(parts.some((p) => p.type === 'integer'));
});

Deno.test('Intl.NumberFormat: formatRange', () => {
    const f = new Intl.NumberFormat('en-US');
    const s = f.formatRange(1, 5);
    ok(typeof s === 'string' && s.length > 0);
});

Deno.test('Intl.NumberFormat: resolvedOptions', () => {
    const f = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'EUR' });
    const o = f.resolvedOptions();
    ok(o.style === 'currency');
    ok(o.currency === 'EUR');
});

// --- Collator -------------------------------------------------------------

Deno.test('Intl.Collator: compare orders strings', () => {
    const c = new Intl.Collator('en-US');
    ok(c.compare('a', 'b') < 0);
    ok(c.compare('b', 'a') > 0);
    ok(c.compare('a', 'a') === 0);
});

Deno.test('Intl.Collator: case-insensitive ordering', () => {
    const c = new Intl.Collator('en-US', { sensitivity: 'base' });
    ok(c.compare('a', 'A') === 0);
});

Deno.test('Intl.Collator: resolvedOptions', () => {
    const c = new Intl.Collator('en-US', { numeric: true });
    const o = c.resolvedOptions();
    ok(o.numeric === true);
});

Deno.test('Intl.Collator: supportedLocalesOf', () => {
    const locales = Intl.Collator.supportedLocalesOf(['en-US', 'de-DE']);
    ok(Array.isArray(locales));
});

// --- PluralRules ----------------------------------------------------------

Deno.test('Intl.PluralRules: selects plural category', () => {
    const r = new Intl.PluralRules('en-US');
    strictEqual(r.select(1), 'one');
    strictEqual(r.select(5), 'other');
});

Deno.test('Intl.PLuralRules: selectRange', () => {
    const r = new Intl.PluralRules('en-US');
    const cat = r.selectRange(1, 5);
    ok(typeof cat === 'string');
});

Deno.test('Intl.PluralRules: resolvedOptions', () => {
    const r = new Intl.PluralRules('en-US');
    const o = r.resolvedOptions();
    ok(o.type === 'cardinal' || o.type === 'ordinal');
});

// --- DisplayNames ----------------------------------------------------------

Deno.test('Intl.DisplayNames: language display', () => {
    const d = new Intl.DisplayNames('en-US', { type: 'language' });
    const s = d.of('fr');
    ok(typeof s === 'string' && s.length > 0);
});

Deno.test('Intl.DisplayNames: region display', () => {
    const d = new Intl.DisplayNames('en-US', { type: 'region' });
    const s = d.of('US');
    ok(typeof s === 'string' && s.length > 0);
});

Deno.test('Intl.DisplayNames: currency display', () => {
    const d = new Intl.DisplayNames('en-US', { type: 'currency' });
    const s = d.of('USD');
    ok(typeof s === 'string' && s.length > 0);
});

Deno.test('Intl.DisplayNames: resolvedOptions', () => {
    const d = new Intl.DisplayNames('en-US', { type: 'region' });
    const o = d.resolvedOptions();
    ok(o.type === 'region');
});

// --- RelativeTimeFormat ---------------------------------------------------

Deno.test('Intl.RelativeTimeFormat: formats relative time', () => {
    const f = new Intl.RelativeTimeFormat('en-US');
    const s = f.format(-1, 'day');
    ok(typeof s === 'string' && s.length > 0);
});

Deno.test('Intl.RelativeTimeFormat: formatToParts', () => {
    const f = new Intl.RelativeTimeFormat('en-US');
    const parts = f.formatToParts(3, 'month');
    ok(Array.isArray(parts));
});

// --- ListFormat -----------------------------------------------------------

Deno.test('Intl.ListFormat: formats list', () => {
    const f = new Intl.ListFormat('en-US');
    const s = f.format(['a', 'b', 'c']);
    ok(typeof s === 'string' && s.includes('a') && s.includes('c'));
});

// --- getCanonicalLocales ---------------------------------------------------

Deno.test('Intl.getCanonicalLocales normalizes', () => {
    const out = Intl.getCanonicalLocales('EN-us');
    ok(Array.isArray(out));
    ok(out[0] === 'en-US');
});
