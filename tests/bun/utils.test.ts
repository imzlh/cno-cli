import { deepStrictEqual, strictEqual, throws } from 'node:assert';
import { escapeHTML } from '../../cno/src/bun/utils/escape-html.ts';

Deno.test('bun: escapeHTML escapes HTML metacharacters without double processing', () => {
    strictEqual(escapeHTML.name, 'escapeHTML');
    strictEqual(escapeHTML.length, 2);
    deepStrictEqual(Reflect.ownKeys(escapeHTML), ['length', 'name']);
    deepStrictEqual(Object.getOwnPropertyDescriptor(escapeHTML, 'length'), {
        value: 2,
        writable: false,
        enumerable: false,
        configurable: true,
    });
    deepStrictEqual(Object.getOwnPropertyDescriptor(escapeHTML, 'name'), {
        value: 'escapeHTML',
        writable: false,
        enumerable: false,
        configurable: true,
    });
    strictEqual(Object.getPrototypeOf(escapeHTML), Function.prototype);
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

Deno.test('bun: escapeHTML ignores surplus arguments and stringifies a missing argument', () => {
    strictEqual(Reflect.apply(escapeHTML, { ignored: true }, []), 'undefined');
    strictEqual(Reflect.apply(escapeHTML, null, [`<&>"'`, Symbol('ignored')]), '&lt;&amp;&gt;&quot;&#x27;');
});

Deno.test('bun: escapeHTML follows string-hint ordinary coercion order', () => {
    const order: string[] = [];
    const input = {
        get [Symbol.toPrimitive]() {
            order.push('get:@@toPrimitive');
            return undefined;
        },
        get toString() {
            order.push('get:toString');
            return function (this: unknown) {
                order.push(`call:toString:${this === input}`);
                return {};
            };
        },
        get valueOf() {
            order.push('get:valueOf');
            return function (this: unknown) {
                order.push(`call:valueOf:${this === input}`);
                return '<&>';
            };
        },
    };

    strictEqual(escapeHTML(input), '&lt;&amp;&gt;');
    deepStrictEqual(order, [
        'get:@@toPrimitive',
        'get:toString',
        'call:toString:true',
        'get:valueOf',
        'call:valueOf:true',
    ]);

    const sentinel = new RangeError('primitive getter');
    let fallbackRead = false;
    let thrown: unknown;
    try {
        escapeHTML({
            get [Symbol.toPrimitive](): never { throw sentinel; },
            get toString() {
                fallbackRead = true;
                return () => '<never>';
            },
        });
    } catch (error) {
        thrown = error;
    }
    strictEqual(thrown, sentinel);
    strictEqual(fallbackRead, false);
});

Deno.test('bun: escapeHTML preserves UTF-16 boundaries around escaped characters', () => {
    strictEqual(
        escapeHTML('\ud7ff<&\ud800\udbff&\udc00\udfff\ue000'),
        '\ud7ff&lt;&amp;\ud800\udbff&amp;\udc00\udfff\ue000',
    );
    strictEqual(escapeHTML('😀<&>😃'), '😀&lt;&amp;&gt;😃');
    strictEqual(escapeHTML('e\u0301<&>\u200d\ufe0f\ufffe\uffff'), 'e\u0301&lt;&amp;&gt;\u200d\ufe0f\ufffe\uffff');
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
