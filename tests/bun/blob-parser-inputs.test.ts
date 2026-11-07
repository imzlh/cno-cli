import { deepStrictEqual, strictEqual, throws } from 'node:assert';
import { file } from '../../cno/src/bun/file.ts';
import { JSON5 } from '../../cno/src/bun/utils/json5.ts';
import { TOML } from '../../cno/src/bun/utils/toml.ts';

Deno.test('bun: JSON5 synchronously parses in-memory Blob and File inputs', () => {
    const source = '{answer: 42}';
    const wrapped = new Blob([`xx${source}yy`]);

    deepStrictEqual(JSON5.parse(new Blob([source])), { answer: 42 });
    deepStrictEqual(JSON5.parse(new File([source], 'input.json5')), { answer: 42 });
    deepStrictEqual(JSON5.parse(wrapped.slice(2, 2 + source.length)), { answer: 42 });
    throws(() => JSON5.parse(new Blob([])), {
        name: 'SyntaxError',
        message: 'JSON5 Parse error: Unexpected end of input',
    });
    throws(() => JSON5.parse(new Blob([new Uint8Array([0xff])])), {
        name: 'SyntaxError',
        message: 'JSON5 Parse error: Unexpected token',
    });
});

Deno.test('bun: TOML synchronously parses in-memory Blob and File inputs', () => {
    const source = 'answer = 42';
    const wrapped = new Blob([`xx${source}yy`]);

    deepStrictEqual(TOML.parse(new Blob([source])), { answer: 42 });
    deepStrictEqual(TOML.parse(new File([source], 'input.toml')), { answer: 42 });
    deepStrictEqual(TOML.parse(wrapped.slice(2, 2 + source.length)), { answer: 42 });
    deepStrictEqual(TOML.parse(new Blob([])), {});
    throws(() => TOML.parse(new Blob([new Uint8Array([0xff])])), {
        name: 'SyntaxError',
        message: 'TOML Parse error: Invalid UTF-8 byte sequence',
    });
});

Deno.test('bun: synchronous parsers reject BunFile before Blob byte extraction', () => {
    const input = file('not-read-by-sync-parser');
    for (const parse of [JSON5.parse, TOML.parse]) {
        throws(() => parse(input), (error: unknown) => {
            const value = error as TypeError & { code?: string };
            return value instanceof TypeError
                && value.message === 'File blob cannot be used here'
                && value.code === 'ERR_INVALID_ARG_TYPE';
        });
    }
});

Deno.test('bun: synchronous parsers require real Blob internal slots', () => {
    const fake = (source: string) => ({
        size: source.length,
        [Symbol.toStringTag]: 'Blob',
        [Symbol.for('cno.blob.bytes')]() { throw new Error('forged byte hook ran'); },
        toString() { return source; },
    });

    deepStrictEqual(JSON5.parse(fake('{answer: 42}')), { answer: 42 });
    deepStrictEqual(TOML.parse(fake('answer = 42')), { answer: 42 });
    throws(() => JSON5.parse(new Proxy(new Blob(['{answer: 42}']), {})));
    throws(() => TOML.parse(new Proxy(new Blob(['answer = 42']), {})));
});

Deno.test('bun: synchronous parsers retain the captured Blob intrinsics', () => {
    const json = new Blob(['{answer: 42}']);
    const toml = new Blob(['answer = 42']);
    const BlobConstructor = globalThis.Blob;
    try {
        Reflect.set(globalThis, 'Blob', class ReplacementBlob {});
        deepStrictEqual(JSON5.parse(json), { answer: 42 });
        deepStrictEqual(TOML.parse(toml), { answer: 42 });
    } finally {
        Reflect.set(globalThis, 'Blob', BlobConstructor);
    }
    strictEqual(globalThis.Blob, BlobConstructor);
});
