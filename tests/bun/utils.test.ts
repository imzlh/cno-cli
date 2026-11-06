import { strictEqual, throws } from 'node:assert';
import { escapeHTML } from '../../cno/src/bun/utils/escape-html.ts';

Deno.test('bun: escapeHTML escapes HTML metacharacters without double processing', () => {
    strictEqual(escapeHTML.name, 'escapeHTML');
    strictEqual(escapeHTML.length, 2);
    strictEqual(Object.hasOwn(escapeHTML, 'prototype'), false);
    throws(() => Reflect.construct(escapeHTML, ['<']), TypeError);
    strictEqual(escapeHTML(`<&>"'`), '&lt;&amp;&gt;&quot;&#x27;');
    strictEqual(escapeHTML('&amp;'), '&amp;amp;');
    strictEqual(escapeHTML('plain café'), 'plain café');
    strictEqual(escapeHTML('/`=\0\ud800\udc00'), '/`=\0\ud800\udc00');
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

Deno.test('bun: escapeHTML preserves coercion effects and errors without consulting String.prototype', () => {
    let coercions = 0;
    strictEqual(escapeHTML({
        [Symbol.toPrimitive](hint: string) {
            coercions++;
            strictEqual(hint, 'string');
            return '<&>';
        },
    }), '&lt;&amp;&gt;');
    strictEqual(coercions, 1);

    const sentinel = new RangeError('sentinel');
    let thrown: unknown;
    try {
        escapeHTML({ toString: () => { throw sentinel; } });
    } catch (error) {
        thrown = error;
    }
    strictEqual(thrown, sentinel);

    const replaceDescriptor = Object.getOwnPropertyDescriptor(String.prototype, 'replace')!;
    try {
        strictEqual(escapeHTML({
            [Symbol.toPrimitive]() {
                Object.defineProperty(String.prototype, 'replace', {
                    configurable: true,
                    value: () => { throw new Error('replace called'); },
                    writable: true,
                });
                return `<&>"'`;
            },
        }), '&lt;&amp;&gt;&quot;&#x27;');
    } finally {
        Object.defineProperty(String.prototype, 'replace', replaceDescriptor);
    }
});
