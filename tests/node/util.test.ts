import { deepStrictEqual, ok, strictEqual, throws } from 'node:assert';
import utilDefault, {
    MIMEParams,
    MIMEType,
    aborted,
    debug,
    debuglog,
    deprecate,
    callbackify,
    format,
    formatWithOptions,
    getSystemErrorMap,
    getSystemErrorMessage,
    getSystemErrorName,
    inherits,
    inspect,
    isDeepStrictEqual,
    parseArgs,
    parseEnv,
    promisify,
    stripVTControlCharacters,
    styleText,
    TextDecoder as UtilTextDecoder,
    TextEncoder as UtilTextEncoder,
    toUSVString,
    types,
} from 'node:util';

Deno.test('util: format handles placeholders escaping and trailing args', () => {
    strictEqual(format('hello %s %d %%', 'x', '4'), 'hello x 4 %');
    strictEqual(format('%i %f', 4.9, '1.25x'), '4 1.25');
    strictEqual(format('%j', { a: 1 }), '{"a":1}');
    strictEqual(format('%o', [10, 11]), '[ 10, 11, [length]: 2 ]');
    strictEqual(format('left %s', 'one', 'two'), 'left one two');
    strictEqual(format(undefined), '');
});

Deno.test('util upstream: format numeric specifiers match Node coercion edges', () => {
    strictEqual(format('%d %i', 1n, 1n), '1n 1n');
    strictEqual(format('%d %i', Symbol('x'), Symbol('x')), 'NaN NaN');
    strictEqual(format('%i %i %i', -4.9, '-4.9', null), '-4 -4 NaN');
    strictEqual(format('%d %i %f', '1.9x', '1.9x', '1.9x'), 'NaN 1 1.9');
    strictEqual(formatWithOptions({ colors: false }, '%d %i', 1n, -4.9), '1n -4');
});

Deno.test('util: formatWithOptions and inspect options affect object formatting', () => {
    const out = formatWithOptions({ sorted: true, depth: 1 }, 'value=%o', { z: 1, a: { b: 2 } });
    ok(out.includes('value='));
    ok(out.includes('a'));
    ok(out.includes('z'));
});

Deno.test('util upstream: default export debug aliases inspect custom symbol and text coders', () => {
    strictEqual(inspect.custom, Symbol.for('nodejs.util.inspect.custom'));
    strictEqual(debuglog, debug);
    strictEqual(utilDefault.debuglog, debuglog);
    strictEqual(utilDefault.debug, debug);
    strictEqual(utilDefault.inspect.custom, inspect.custom);
    strictEqual(UtilTextEncoder, TextEncoder);
    strictEqual(UtilTextDecoder, TextDecoder);
    ok(new UtilTextEncoder() instanceof TextEncoder);
    ok(new UtilTextDecoder() instanceof TextDecoder);
});

Deno.test('util: terminal helpers normalize control sequences and text styles', () => {
    strictEqual(stripVTControlCharacters('\x1B[31mred\x1B[0m'), 'red');
    strictEqual(styleText('red', 'x', { validateStream: false }), '\x1B[31mx\x1B[39m');
    strictEqual(styleText(['bold', 'underline'], 'x', { validateStream: false }), '\x1B[4m\x1B[1mx\x1B[22m\x1B[24m');
    strictEqual(styleText(['red', 'green'], 'error', { validateStream: false }), '\x1B[32m\x1B[31merror\x1B[39m\x1B[39m');
});

Deno.test('util: toUSVString replaces unpaired surrogates', () => {
    strictEqual(toUSVString('a\uD800b'), 'a\uFFFDb');
    strictEqual(toUSVString('a\uD83D\uDE00b'), 'a\uD83D\uDE00b');
    strictEqual(toUSVString('\uDC00'), '\uFFFD');
});

Deno.test('util: isDeepStrictEqual compares nested built-in values', () => {
    strictEqual(isDeepStrictEqual({ a: [1, { b: true }] }, { a: [1, { b: true }] }), true);
    strictEqual(isDeepStrictEqual(new Set([1, 2]), new Set([2, 1])), true);
    strictEqual(isDeepStrictEqual(new Map([[1, 'a']]), new Map([[1, 'b']])), false);
});

Deno.test('util upstream: types recognize typed arrays and native errors', () => {
    strictEqual(types.isTypedArray(new Uint8Array(4)), true);
    strictEqual(types.isTypedArray(new DataView(new ArrayBuffer(4))), false);
    strictEqual(types.isNativeError(new Error('x')), true);
    strictEqual(types.isNativeError(new TypeError('x')), true);
    strictEqual(types.isNativeError(new DOMException('x')), true);
});

Deno.test('util: inherits wires prototype chain and super_ marker', () => {
    function Base(this: { base?: boolean }) {
        this.base = true;
    }
    Base.prototype.kind = function () {
        return 'base';
    };
    function Child(this: { child?: boolean }) {
        this.child = true;
    }
    inherits(Child, Base);
    const child = new (Child as unknown as new () => { kind(): string })();
    strictEqual(child.kind(), 'base');
    strictEqual((Child as unknown as { super_: Function }).super_, Base);
    throws(() => inherits(Child, null as unknown as Function), TypeError);
});

Deno.test('util: promisify resolves rejects and honors custom implementation', async () => {
    const add = promisify<number>((a: number, b: number, cb: (err: Error | null, value?: number) => void) => {
        cb(null, a + b);
    });
    strictEqual(await add(2, 3), 5);

    const fail = promisify<number>((cb: (err: Error) => void) => cb(new Error('boom')));
    await fail().then(
        () => { throw new Error('expected rejection'); },
        (err) => strictEqual(err.message, 'boom'),
    );

    const custom = () => {};
    const customImpl = () => Promise.resolve('custom');
    custom[promisify.custom as unknown as keyof typeof custom] = customImpl as never;
    strictEqual(promisify(custom), customImpl);
});

Deno.test('util: callbackify forwards fulfillment rejection and falsy rejection', async () => {
    const okFn = callbackify(async (value: number) => value * 2);
    await new Promise<void>((resolve, reject) => {
        okFn(4, (err: Error | null, value: number) => {
            try {
                strictEqual(err, null);
                strictEqual(value, 8);
                resolve();
            } catch (e) {
                reject(e);
            }
        });
    });

    const rejectFn = callbackify(async () => {
        throw new TypeError('bad');
    });
    await new Promise<void>((resolve, reject) => {
        rejectFn((err: Error) => {
            try {
                strictEqual(err.name, 'TypeError');
                strictEqual(err.message, 'bad');
                resolve();
            } catch (e) {
                reject(e);
            }
        });
    });

    const falsyFn = callbackify(async () => {
        throw null;
    });
    await new Promise<void>((resolve, reject) => {
        falsyFn((err: Error & { code?: string; reason?: unknown }) => {
            try {
                strictEqual(err.code, 'ERR_FALSY_VALUE_REJECTION');
                strictEqual(err.reason, null);
                resolve();
            } catch (e) {
                reject(e);
            }
        });
    });
});

Deno.test('util upstream: deprecate returns callable wrapper and callbackify validates input', () => {
    let called = false;
    const wrapped = deprecate(() => {
        called = true;
    }, 'deprecated test function');
    wrapped();
    strictEqual(called, true);
    throws(() => callbackify(undefined as unknown as () => Promise<unknown>), TypeError);
});

Deno.test('util: parseArgs handles strings booleans defaults negation and tokens', () => {
    const parsed = parseArgs({
        args: ['--name=alice', '-v', '--no-color', '--tag', 'one', '--', 'pos'],
        options: {
            name: { type: 'string' },
            verbose: { type: 'boolean', short: 'v' },
            color: { type: 'boolean', default: true },
            tag: { type: 'string', multiple: true },
        },
        allowNegative: true,
        allowPositionals: true,
        tokens: true,
    });
    strictEqual(parsed.values.color, false);
    strictEqual(parsed.values.name, 'alice');
    strictEqual(parsed.values.verbose, true);
    deepStrictEqual(parsed.values.tag, ['one']);
    deepStrictEqual(parsed.positionals, ['pos']);
    strictEqual(parsed.tokens?.at(-1)?.kind, 'positional');
    throws(() => parseArgs({ args: ['--unknown'], options: {} }), (err: Error & { code?: string }) => {
        strictEqual(err.code, 'ERR_PARSE_ARGS_UNKNOWN_OPTION');
        return true;
    });
});

Deno.test('util: system error helpers expose errno map and validate arguments', () => {
    const map = getSystemErrorMap();
    ok(map.size > 0);
    const [code, [name, message]] = map.entries().next().value;
    strictEqual(getSystemErrorName(code), name);
    strictEqual(getSystemErrorMessage(code), message);
    strictEqual(getSystemErrorName(-424242), undefined);
    strictEqual(getSystemErrorMessage(-424242), undefined);
    throws(() => (getSystemErrorName as (err?: unknown) => unknown)(), TypeError);
    throws(() => (getSystemErrorName as (err: unknown) => unknown)(1), RangeError);
    throws(() => (getSystemErrorMessage as (err?: unknown) => unknown)(), TypeError);
    throws(() => (getSystemErrorMessage as (err: unknown) => unknown)(1), RangeError);
});

Deno.test('util: MIMEType parses essence params and serializes updates', () => {
    const mime = new MIMEType('Text/HTML; Charset=UTF-8; boundary=abc');
    strictEqual(mime.type, 'text');
    strictEqual(mime.subtype, 'html');
    strictEqual(mime.essence, 'text/html');
    strictEqual(mime.params.get('charset'), 'UTF-8');
    strictEqual(mime.params.has('BOUNDARY'), true);
    mime.params.set('format', 'flowed');
    mime.params.delete('boundary');
    strictEqual(mime.toString(), 'text/html;charset=UTF-8;format=flowed');
});

Deno.test('util: MIMEType validates essence and keeps parseable first parameters', () => {
    throws(() => new MIMEType('text'), TypeError);
    throws(() => new MIMEType('/plain'), TypeError);
    throws(() => new MIMEType('text/'), TypeError);
    throws(() => new MIMEType('te xt/plain'), TypeError);

    const mime = new MIMEType('text/plain; foo="a;b"; foo=second; empty=; bad name=x; line=a\nb');
    strictEqual(mime.params.get('foo'), 'a;b');
    strictEqual(mime.params.get('empty'), null);
    strictEqual(mime.params.get('bad name'), null);
    strictEqual(mime.toString(), 'text/plain;foo="a;b"');
});

Deno.test('util: MIMEParams validates runtime updates and serializes quoted values', () => {
    const params = new MIMEParams();
    params.set('Charset', 'UTF-8');
    params.set('title', 'hello world');
    params.set('semi', 'a;b');

    deepStrictEqual([...params], [
        ['charset', 'UTF-8'],
        ['title', 'hello world'],
        ['semi', 'a;b'],
    ]);
    strictEqual(params.toString(), 'charset=UTF-8;title="hello world";semi="a;b"');

    throws(() => params.set('bad name', 'x'), TypeError);
    throws(() => params.set('ok', 'line\nbreak'), TypeError);
    throws(() => Reflect.apply(params.set, params, ['missing-value']), TypeError);
    throws(() => Reflect.apply(params.get, params, []), TypeError);
});

Deno.test('util: aborted resolves for already and later aborted signals', async () => {
    const already = new AbortController();
    already.abort();
    strictEqual((await aborted(already.signal, {})).type, 'abort');

    const later = new AbortController();
    const event = aborted(later.signal, {});
    later.abort();
    strictEqual((await event).type, 'abort');
});

Deno.test('util: parseEnv supports comments quoting multiline and expansion', () => {
    const parsed = parseEnv([
        '# comment',
        'A=one # stripped',
        'export B="two\\n${A}"',
        "C='literal ${A}'",
        'D',
        'E="multi',
        'line"',
    ].join('\n'));
    deepStrictEqual(parsed, {
        A: 'one',
        B: 'two\none',
        C: 'literal ${A}',
        D: '',
        E: 'multi\nline',
    });
});
