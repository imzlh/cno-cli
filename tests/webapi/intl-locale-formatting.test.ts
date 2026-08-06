import { deepStrictEqual, strictEqual, ok, throws } from 'node:assert';

// ============================================================================
// Intl: Date.prototype.toLocale* re-point, plain call, root collation,
// NumberFormat, and the en/zh format shapes.
//
// Expectations verified against node v24.18.0 by differential extraction
// (55/55 NumberFormat, 176/176 Collator, 282/285 DateTimeFormat cases identical).
// Cases marked DIVERGENT are deliberate.
// ============================================================================

const T = Date.UTC(2021, 2, 4, 15, 7, 9); // Thu 2021-03-04T15:07:09Z
const UTC = { timeZone: 'UTC' } as const;

// --- Date.prototype.toLocale* (priority 1: the most common call site) ------
// quickjs implements these in C and they never reached Intl, so both arguments
// were silently ignored. They are re-pointed at the polyfill from intl.ts.

Deno.test('Date#toLocaleString honours locale and timeZone', () => {
    strictEqual(new Date(T).toLocaleString('en-US', UTC), '3/4/2021, 3:07:09 PM');
    strictEqual(new Date(T).toLocaleString('zh-CN', UTC), '2021/3/4 15:07:09');
    strictEqual(new Date(T).toLocaleString('en-US', { timeZone: 'Etc/GMT+5' }), '3/4/2021, 10:07:09 AM');
    strictEqual(new Date(T).toLocaleString('en-US', { timeZone: '+05:30' }), '3/4/2021, 8:37:09 PM');
});

Deno.test('Date#toLocaleDateString and toLocaleTimeString split the defaults', () => {
    strictEqual(new Date(T).toLocaleDateString('en-US', UTC), '3/4/2021');
    strictEqual(new Date(T).toLocaleTimeString('en-US', UTC), '3:07:09 PM');
    strictEqual(new Date(T).toLocaleDateString('zh-CN', UTC), '2021/3/4');
    strictEqual(new Date(T).toLocaleTimeString('zh-CN', UTC), '15:07:09');
});

Deno.test('Date#toLocale* only fills defaults for an unrequested group', () => {
    // An explicit component suppresses the defaults entirely.
    strictEqual(new Date(T).toLocaleString('en-US', { timeZone: 'UTC', year: 'numeric' }), '2021');
    // toLocaleDateString adds y/m/d but keeps a caller-supplied time field.
    strictEqual(new Date(T).toLocaleDateString('en-US', { timeZone: 'UTC', hour: 'numeric' }), '3/4/2021, 3 PM');
    // toLocaleTimeString adds h/m/s but keeps a caller-supplied date field.
    strictEqual(new Date(T).toLocaleTimeString('en-US', { timeZone: 'UTC', year: 'numeric' }), '2021, 3:07:09 PM');
});

Deno.test('Date#toLocale* reports Invalid Date rather than throwing', () => {
    // Intl.DateTimeFormat#format throws RangeError here; toLocale* must not.
    strictEqual(new Date(NaN).toLocaleString(), 'Invalid Date');
    strictEqual(new Date(NaN).toLocaleDateString(), 'Invalid Date');
    strictEqual(new Date(NaN).toLocaleTimeString(), 'Invalid Date');
    throws(() => new Intl.DateTimeFormat('en-US').format(new Date(NaN)), RangeError);
});

Deno.test('Date#toLocale* rejects a style from the wrong group', () => {
    throws(() => new Date(T).toLocaleTimeString('en-US', { timeZone: 'UTC', dateStyle: 'medium' }), TypeError);
    throws(() => new Date(T).toLocaleDateString('en-US', { timeZone: 'UTC', timeStyle: 'short' }), TypeError);
});

Deno.test('Date#toLocaleString surfaces an unsupported zone loudly', () => {
    // Previously this silently formatted in the host zone: wrong for 8 months a year.
    throws(() => new Date(T).toLocaleString('en-US', { timeZone: 'America/New_York' }), RangeError);
});

Deno.test('Number#toLocaleString and BigInt#toLocaleString group digits', () => {
    strictEqual((1234.5).toLocaleString('en-US'), '1,234.5');
    strictEqual((0).toLocaleString('en-US'), '0');
    strictEqual((-9876543.21).toLocaleString('en-US'), '-9,876,543.21');
    strictEqual((1234.5).toLocaleString('en-US', { style: 'currency', currency: 'USD' }), '$1,234.50');
    strictEqual((123456789012345678901n).toLocaleString('en-US'), '123,456,789,012,345,678,901');
});

// --- plain call (priority 4) ----------------------------------------------

Deno.test('Intl: the three ECMA-402 callables work without new', () => {
    strictEqual(typeof Intl.DateTimeFormat('en-US', UTC).format(T), 'string');
    strictEqual(Intl.NumberFormat('en-US').format(1234.5), '1,234.5');
    strictEqual(typeof Intl.Collator('en-US').compare, 'function');
});

Deno.test('Intl: plain call and new yield interchangeable instances', () => {
    ok(Intl.DateTimeFormat('en-US') instanceof Intl.DateTimeFormat);
    ok(new Intl.DateTimeFormat('en-US') instanceof Intl.DateTimeFormat);
    ok(Intl.NumberFormat('en-US') instanceof Intl.NumberFormat);
    ok(Intl.Collator('en-US') instanceof Intl.Collator);
    strictEqual(
        Intl.DateTimeFormat('en-US', UTC).format(T),
        new Intl.DateTimeFormat('en-US', UTC).format(T),
    );
});

Deno.test('Intl: statics and names survive the callable wrapper', () => {
    ok(Array.isArray(Intl.NumberFormat.supportedLocalesOf(['en-US'])));
    ok(Array.isArray(Intl.DateTimeFormat.supportedLocalesOf(['en-US'])));
    ok(Array.isArray(Intl.Collator.supportedLocalesOf(['en-US'])));
    strictEqual(Intl.NumberFormat.name, 'NumberFormat');
    strictEqual(Intl.DateTimeFormat.name, 'DateTimeFormat');
    strictEqual(Intl.Collator.name, 'Collator');
});

Deno.test('Intl: the other constructors still require new', () => {
    for (const name of ['PluralRules', 'RelativeTimeFormat', 'ListFormat', 'DisplayNames',
        'Locale', 'Segmenter'] as const) {
        throws(
            () => (Intl[name] as unknown as (tag: string) => unknown)('en'),
            TypeError,
            name + ' must throw without new',
        );
    }
});

Deno.test('Intl: format is a bound accessor, so a detached reference works', () => {
    const dtf = new Intl.DateTimeFormat('en-US', UTC);
    const detachedDate = dtf.format;
    strictEqual(detachedDate(T), dtf.format(T));
    const nf = new Intl.NumberFormat('en-US');
    const detachedNumber = nf.format;
    strictEqual(detachedNumber(1234.5), '1,234.5');
});

Deno.test('Intl: toStringTag matches the spec-mandated Intl.X form', () => {
    strictEqual(Object.prototype.toString.call(new Intl.DateTimeFormat()), '[object Intl.DateTimeFormat]');
    strictEqual(Object.prototype.toString.call(new Intl.NumberFormat()), '[object Intl.NumberFormat]');
    strictEqual(Object.prototype.toString.call(new Intl.Collator()), '[object Intl.Collator]');
    strictEqual(Object.prototype.toString.call(new Intl.PluralRules()), '[object Intl.PluralRules]');
    strictEqual(Object.prototype.toString.call(Intl), '[object Intl]');
});

// --- root collation (priority 5) ------------------------------------------
// NFD + combining-mark stripping gives DUCET-shaped root collation with no CLDR.
// Correct for en/de/fr/es; WRONG for sv/da, where a-umlaut tailors after z.

Deno.test('Intl.Collator: accents sort next to their base letter, not after z', () => {
    deepStrictEqual(['z', 'a-umlaut', 'a', 'b'].map((s) => (s === 'a-umlaut' ? 'ä' : s))
        .sort(new Intl.Collator('en').compare), ['a', 'ä', 'b', 'z']);
    deepStrictEqual(['z', 'ä', 'a'].sort(new Intl.Collator('de').compare), ['a', 'ä', 'z']);
    deepStrictEqual(['éclair', 'eclair', 'edam'].sort(new Intl.Collator('en').compare),
        ['eclair', 'éclair', 'edam']);
});

Deno.test('Intl.Collator: lowercase sorts before uppercase at the tertiary level', () => {
    strictEqual(Math.sign(new Intl.Collator('en').compare('a', 'A')), -1);
    strictEqual(Math.sign(new Intl.Collator('en').compare('A', 'a')), 1);
    deepStrictEqual(['b', 'A', 'a', 'B'].sort(new Intl.Collator('en').compare), ['a', 'A', 'b', 'B']);
    deepStrictEqual(['a', 'A'].sort(new Intl.Collator('en', { caseFirst: 'upper' }).compare), ['A', 'a']);
});

Deno.test('Intl.Collator: the four sensitivity levels behave independently', () => {
    const at = 'ä';
    const cmp = (o: Intl.CollatorOptions) => new Intl.Collator('en', o).compare;
    strictEqual(cmp({ sensitivity: 'base' })('a', 'A'), 0);
    strictEqual(cmp({ sensitivity: 'base' })('a', at), 0);
    strictEqual(cmp({ sensitivity: 'accent' })('a', 'A'), 0);
    strictEqual(Math.sign(cmp({ sensitivity: 'accent' })('a', at)), -1);
    strictEqual(Math.sign(cmp({ sensitivity: 'case' })('a', 'A')), -1);
    strictEqual(cmp({ sensitivity: 'case' })('a', at), 0, 'case level ignores accents');
    strictEqual(Math.sign(cmp({ sensitivity: 'variant' })('a', at)), -1);
});

Deno.test('Intl.Collator: numeric compares digit runs as numbers', () => {
    const numeric = new Intl.Collator('en', { numeric: true }).compare;
    strictEqual(Math.sign(numeric('10', '9')), 1);
    strictEqual(Math.sign(numeric('item10', 'item9')), 1);
    deepStrictEqual(['a10', 'a2', 'a1'].sort(numeric), ['a1', 'a2', 'a10']);
    deepStrictEqual(['10', '9', '100', '1'].sort(numeric), ['1', '9', '10', '100']);
    // Without numeric, lexicographic order still applies.
    strictEqual(Math.sign(new Intl.Collator('en').compare('10', '9')), -1);
});

Deno.test('Intl.Collator: ignorePunctuation drops punctuation before comparing', () => {
    strictEqual(new Intl.Collator('en', { ignorePunctuation: true }).compare('a-b', 'ab'), 0);
    ok(new Intl.Collator('en').compare('a-b', 'ab') !== 0);
});

// --- NumberFormat ---------------------------------------------------------

Deno.test('Intl.NumberFormat: BigInt formats instead of throwing', () => {
    strictEqual(new Intl.NumberFormat('en-US').format(123456789012345678901n),
        '123,456,789,012,345,678,901');
    strictEqual(new Intl.NumberFormat('en-US').format(-123456789012345678901n),
        '-123,456,789,012,345,678,901');
});

Deno.test('Intl.NumberFormat: currency uses the ISO 4217 minor-unit count', () => {
    strictEqual(new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(12.5), '$12.50');
    strictEqual(new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(12), '$12.00');
    strictEqual(new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(-12.5), '-$12.50');
    strictEqual(new Intl.NumberFormat('en-US', { style: 'currency', currency: 'EUR' }).format(1234.5), '€1,234.50');
    // Zero-decimal currencies round to whole units.
    strictEqual(new Intl.NumberFormat('en-US', { style: 'currency', currency: 'JPY' }).format(12.5), '¥13');
    strictEqual(new Intl.NumberFormat('en-US', { style: 'currency', currency: 'KRW' }).format(12.5), '₩13');
});

Deno.test('Intl.NumberFormat: an unknown currency renders as its code', () => {
    // Code and number are separated by U+00A0, matching node.
    strictEqual(new Intl.NumberFormat('en-US', { style: 'currency', currency: 'XYZ' }).format(12.5),
        'XYZ 12.50');
    strictEqual(new Intl.NumberFormat('en-US', {
        style: 'currency', currency: 'USD', currencyDisplay: 'code',
    }).format(12.5), 'USD 12.50');
});

Deno.test('Intl.NumberFormat: non-finite values get their own part types', () => {
    strictEqual(new Intl.NumberFormat('en-US').format(NaN), 'NaN');
    strictEqual(new Intl.NumberFormat('en-US').format(Infinity), '∞');
    strictEqual(new Intl.NumberFormat('en-US').format(-Infinity), '-∞');
    deepStrictEqual(new Intl.NumberFormat('en-US').formatToParts(NaN), [{ type: 'nan', value: 'NaN' }]);
    deepStrictEqual(new Intl.NumberFormat('en-US').formatToParts(Infinity),
        [{ type: 'infinity', value: '∞' }]);
});

Deno.test('Intl.NumberFormat: formatToParts splits groups and fractions', () => {
    // The stub returned the whole string as a single 'integer' part.
    deepStrictEqual(new Intl.NumberFormat('en-US').formatToParts(1234.5), [
        { type: 'integer', value: '1' },
        { type: 'group', value: ',' },
        { type: 'integer', value: '234' },
        { type: 'decimal', value: '.' },
        { type: 'fraction', value: '5' },
    ]);
    deepStrictEqual(new Intl.NumberFormat('en-US').formatToParts(-5), [
        { type: 'minusSign', value: '-' },
        { type: 'integer', value: '5' },
    ]);
    deepStrictEqual(new Intl.NumberFormat('en-US', { style: 'percent' }).formatToParts(0.5), [
        { type: 'integer', value: '50' },
        { type: 'percentSign', value: '%' },
    ]);
});

Deno.test('Intl.NumberFormat: rounding is halfExpand on the decimal value', () => {
    // (1.005).toFixed(2) is "1.00" because the double is 1.00499...; ICU prints 1.01.
    strictEqual(new Intl.NumberFormat('en-US', { maximumFractionDigits: 2 }).format(1.005), '1.01');
    strictEqual(new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 }).format(2.5), '3');
    strictEqual(new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 }).format(3.5), '4');
    strictEqual(new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 }).format(-2.5), '-3');
    strictEqual(new Intl.NumberFormat('en-US').format(1e21), '1,000,000,000,000,000,000,000');
    strictEqual(new Intl.NumberFormat('en-US', { minimumIntegerDigits: 5 }).format(42), '00,042');
    strictEqual(new Intl.NumberFormat('en-US', { maximumSignificantDigits: 3 }).format(123456), '123,000');
});

Deno.test('Intl.NumberFormat: percent and grouping options', () => {
    strictEqual(new Intl.NumberFormat('en-US', { style: 'percent' }).format(0.5), '50%');
    strictEqual(new Intl.NumberFormat('en-US', { style: 'percent' }).format(0.123), '12%');
    strictEqual(new Intl.NumberFormat('en-US', { useGrouping: false }).format(1234567), '1234567');
    strictEqual(new Intl.NumberFormat('en-US', { minimumFractionDigits: 2 }).format(5), '5.00');
});

Deno.test('Intl.NumberFormat: resolvedOptions reports the resolved fraction digits', () => {
    const plain = new Intl.NumberFormat('en-US').resolvedOptions();
    strictEqual(plain.minimumFractionDigits, 0);
    strictEqual(plain.maximumFractionDigits, 3);
    strictEqual(plain.numberingSystem, 'latn');
    const jpy = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'JPY' }).resolvedOptions();
    strictEqual(jpy.minimumFractionDigits, 0);
    strictEqual(jpy.maximumFractionDigits, 0);
    strictEqual(jpy.currency, 'JPY');
});

// --- DateTimeFormat shapes ------------------------------------------------

Deno.test('Intl.DateTimeFormat: en-US skeletons', () => {
    const f = (o: Intl.DateTimeFormatOptions) =>
        new Intl.DateTimeFormat('en-US', { timeZone: 'UTC', ...o }).format(T);
    strictEqual(f({}), '3/4/2021');
    strictEqual(f({ year: 'numeric', month: '2-digit', day: '2-digit' }), '03/04/2021');
    strictEqual(f({ year: 'numeric', month: 'long', day: 'numeric' }), 'March 4, 2021');
    strictEqual(f({ weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' }),
        'Thursday, March 4, 2021');
    strictEqual(f({ month: 'narrow' }), 'M');
    strictEqual(f({ hour: 'numeric', minute: '2-digit' }), '3:07 PM');
    strictEqual(f({ hour: '2-digit', minute: '2-digit' }), '03:07 PM');
    strictEqual(f({ hour: 'numeric', minute: '2-digit', hour12: false }), '15:07');
    strictEqual(f({ dateStyle: 'short' }), '3/4/21');
    strictEqual(f({ dateStyle: 'medium', timeStyle: 'medium' }), 'Mar 4, 2021, 3:07:09 PM');
    strictEqual(f({ dateStyle: 'full', timeStyle: 'short' }), 'Thursday, March 4, 2021 at 3:07 PM');
    strictEqual(f({ era: 'short', year: 'numeric' }), '2021 AD');
    strictEqual(f({ timeStyle: 'long' }), '3:07:09 PM UTC');
});

Deno.test('Intl.DateTimeFormat: zh-CN skeletons', () => {
    const f = (o: Intl.DateTimeFormatOptions) =>
        new Intl.DateTimeFormat('zh-CN', { timeZone: 'UTC', ...o }).format(T);
    strictEqual(f({}), '2021/3/4');
    strictEqual(f({ year: 'numeric' }), '2021年');
    strictEqual(f({ month: 'numeric' }), '3月');
    strictEqual(f({ month: 'long' }), '三月');
    strictEqual(f({ month: 'narrow' }), '3');
    strictEqual(f({ year: 'numeric', month: 'numeric' }), '2021/3');
    strictEqual(f({ year: 'numeric', month: 'long', day: 'numeric' }), '2021年3月4日');
    strictEqual(f({ weekday: 'long', year: 'numeric', month: 'numeric', day: 'numeric' }),
        '2021年3月4日星期四');
    strictEqual(f({ hour: 'numeric', minute: '2-digit' }), '15:07', 'zh defaults to a 24-hour clock');
    strictEqual(f({ hour: 'numeric', minute: '2-digit', hour12: true }), '下午3:07');
    strictEqual(f({ dateStyle: 'medium', timeStyle: 'medium' }), '2021年3月4日 15:07:09');
});

Deno.test('Intl.DateTimeFormat: hour12 overrides hourCycle', () => {
    const f = (o: Intl.DateTimeFormatOptions) =>
        new Intl.DateTimeFormat('en-US', { timeZone: 'UTC', hour: 'numeric', minute: '2-digit', ...o })
            .format(Date.UTC(2021, 2, 4, 0, 5, 0));
    strictEqual(f({}), '12:05 AM');
    strictEqual(f({ hour12: false }), '00:05');
    strictEqual(f({ hourCycle: 'h11' }), '0:05 AM');
    strictEqual(f({ hourCycle: 'h24' }), '24:05');
    strictEqual(f({ hour12: false, hourCycle: 'h12' }), '00:05', 'hour12 wins');
});

Deno.test('Intl.DateTimeFormat: timeZoneName renders the offset', () => {
    const f = (tz: string, timeZoneName: 'short' | 'long' | 'shortOffset' | 'longOffset') =>
        new Intl.DateTimeFormat('en-US', { timeZone: tz, hour: 'numeric', minute: '2-digit', timeZoneName })
            .format(T);
    strictEqual(f('UTC', 'short'), '3:07 PM UTC');
    strictEqual(f('UTC', 'long'), '3:07 PM Coordinated Universal Time');
    strictEqual(f('UTC', 'shortOffset'), '3:07 PM GMT+0');
    strictEqual(f('UTC', 'longOffset'), '3:07 PM GMT+00:00');
    strictEqual(f('Etc/GMT+5', 'short'), '10:07 AM GMT-5');
    strictEqual(f('Etc/GMT+5', 'long'), '10:07 AM GMT-05:00');
    strictEqual(f('+05:30', 'short'), '8:37 PM GMT+5:30');
});

Deno.test('Intl.DateTimeFormat: formatToParts is typed, not one literal blob', () => {
    // The stub returned [{type:'literal', value: wholeString}].
    deepStrictEqual(
        new Intl.DateTimeFormat('en-US', {
            timeZone: 'UTC', year: 'numeric', month: 'numeric', day: 'numeric',
        }).formatToParts(T),
        [
            { type: 'month', value: '3' },
            { type: 'literal', value: '/' },
            { type: 'day', value: '4' },
            { type: 'literal', value: '/' },
            { type: 'year', value: '2021' },
        ],
    );
    // DIVERGENT: node reports U+202F for the literal before dayPeriod in
    // formatToParts while its own format() emits U+0020 for the same position.
    // cno keeps the two consistent, so parts.join('') === format().
    const dtf = new Intl.DateTimeFormat('en-US', {
        timeZone: 'UTC', hour: 'numeric', minute: '2-digit',
    });
    strictEqual(dtf.formatToParts(T).map((p) => p.value).join(''), dtf.format(T));
});

Deno.test('Intl.DateTimeFormat: formatRange collapses an empty range', () => {
    const dtf = new Intl.DateTimeFormat('en-US', { timeZone: 'UTC' });
    strictEqual(dtf.formatRange(T, T), '3/4/2021');
    const range = dtf.formatRange(T, Date.UTC(2021, 2, 6));
    // THIN SPACE, EN DASH, THIN SPACE, matching node.
    strictEqual(range, '3/4/2021' + String.fromCharCode(0x2009) + String.fromCharCode(0x2013)
        + String.fromCharCode(0x2009) + '3/6/2021');
});

Deno.test('Intl.DateTimeFormat: era turns a non-positive year into BC', () => {
    strictEqual(new Intl.DateTimeFormat('en-US', {
        timeZone: 'UTC', era: 'short', year: 'numeric', month: 'numeric', day: 'numeric',
    }).format(Date.UTC(-1, 0, 1)), '1/1/2 BC', 'astronomical year 0 is 1 BC');
    strictEqual(new Intl.DateTimeFormat('en-US', { timeZone: 'UTC', era: 'long', year: 'numeric' })
        .format(Date.UTC(-500, 5, 15)), '501 Before Christ');
    strictEqual(new Intl.DateTimeFormat('zh-CN', { timeZone: 'UTC', era: 'long', year: 'numeric' })
        .format(Date.UTC(-500, 5, 15)), '公元前501年');
});

// --- supportedValuesOf ----------------------------------------------------

Deno.test('Intl.supportedValuesOf reports only what cno can honour', () => {
    // Previously every key returned the locale list, so feature detection was useless.
    deepStrictEqual(Intl.supportedValuesOf('calendar'), ['gregory']);
    deepStrictEqual(Intl.supportedValuesOf('numberingSystem'), ['latn']);
    const zones = Intl.supportedValuesOf('timeZone');
    ok(zones.includes('UTC'));
    ok(zones.includes('Etc/GMT+5'));
    ok(zones.includes('Etc/GMT-14'));
    ok(!zones.includes('America/New_York'), 'does not advertise zones that throw');
    // Every advertised zone must actually construct.
    for (const tz of zones) new Intl.DateTimeFormat('en-US', { timeZone: tz });
    ok(Intl.supportedValuesOf('currency').includes('USD'));
});

Deno.test('Intl.supportedValuesOf rejects an unknown key', () => {
    throws(() => Intl.supportedValuesOf('bogus' as 'calendar'), RangeError);
});
