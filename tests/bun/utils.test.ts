import { strictEqual, throws } from 'node:assert';
import { escapeHTML } from '../../cno/src/bun/utils/escape-html.ts';

Deno.test('bun: escapeHTML escapes HTML metacharacters without double processing', () => {
    strictEqual(escapeHTML(`<&>"'`), '&lt;&amp;&gt;&quot;&#x27;');
    strictEqual(escapeHTML('&amp;'), '&amp;amp;');
    strictEqual(escapeHTML('plain café'), 'plain café');
    strictEqual(escapeHTML(''), '');
});

Deno.test('bun: escapeHTML applies JavaScript string coercion', () => {
    strictEqual(escapeHTML(42), '42');
    strictEqual(escapeHTML(false), 'false');
    strictEqual(escapeHTML({ toString: () => '<value>' }), '&lt;value&gt;');
    strictEqual(escapeHTML({ [Symbol.toPrimitive]: (hint: string) => hint }), 'string');
    strictEqual(escapeHTML(['<', '>']), '&lt;,&gt;');
    const coerce = escapeHTML as (value: unknown) => string;
    strictEqual(coerce(null), 'null');
    strictEqual(coerce(undefined), 'undefined');
    strictEqual(coerce(1n), '1');
    throws(() => coerce(Symbol('x')), TypeError);
    throws(() => coerce({ [Symbol.toPrimitive]: () => Symbol('x') }), TypeError);
});
