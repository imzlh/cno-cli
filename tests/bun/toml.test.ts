import { deepStrictEqual, strictEqual, throws } from 'node:assert';
import { TOML, parseTOML, stringifyTOML } from '../../cno/src/bun/utils/toml.ts';

denoTest('exports and document syntax', () => {
    strictEqual(TOML.parse, parseTOML);
    strictEqual(TOML.stringify, stringifyTOML);
    strictEqual(TOML.parse.name, 'parse');
    strictEqual(TOML.parse.length, 1);
    strictEqual(TOML.stringify.name, 'stringify');
    strictEqual(TOML.stringify.length, 3);
    throws(() => new (TOML.parse as any)('a=1'), TypeError);
    throws(() => new (TOML.stringify as any)({ a: 1 }), TypeError);
    deepStrictEqual(TOML.parse('\ufeff# heading\r\nname = "demo"\r\ncount=0xDEAD_BEEF\r\nflag=true'), { name: 'demo', count: 0xdeadbeef, flag: true });
    deepStrictEqual(TOML.parse(`title = 'hello'
owner.name = "Tom"
[database]
ports = [8000, # a comment
  8001,]
inline = { enabled = true,
 retries = 2, }
[[products]]
name = "Hammer"
[[products]]
name = "Nail"
[products.details]
color = "gray"`), { title: 'hello', owner: { name: 'Tom' }, database: { ports: [8000, 8001], inline: { enabled: true, retries: 2 } }, products: [{ name: 'Hammer' }, { name: 'Nail', details: { color: 'gray' } }] });
    deepStrictEqual(TOML.parse('"__proto__" = 1\nconstructor = 2'), JSON.parse('{"__proto__":1,"constructor":2}'));
    deepStrictEqual(TOML.parse('[a.b]\nx=1\n[a]\ny=2'), { a: { b: { x: 1 }, y: 2 } });
});

denoTest('strings, numbers, and byte inputs', () => {
    const source = `basic = "a\\n\\t\\u0041\\U0001F600\\e"
literal = 'a\\b'
multi = """
first \\
   second"""
nums = [+1, -0, 0b101, 0o77, 1_000, 1.25e+2, inf, -inf, nan]`;
    const bytes = new TextEncoder().encode(`xx${source}yy`);
    const parsed = TOML.parse(bytes.subarray(2, -2));
    strictEqual(parsed.basic, 'a\n\tA😀\x1b');
    strictEqual(parsed.literal, 'a\\b');
    strictEqual(parsed.multi, 'first second');
    deepStrictEqual(parsed.nums, [1, -0, 5, 63, 1000, 125, Infinity, -Infinity, NaN]);
    deepStrictEqual(TOML.parse(new TextEncoder().encode('a=1').buffer), { a: 1 });
    deepStrictEqual(TOML.parse(new DataView(new TextEncoder().encode('a=1').buffer)), { a: 1 });
    deepStrictEqual(TOML.parse(new Uint8Array([0xff, 97, 61, 49, 0xff]).subarray(1, 4)), { a: 1 });
    for (const bytes of [new Uint8Array([0xff]), new Uint8Array([0xc0, 0xaf])]) {
        throws(() => TOML.parse(bytes), SyntaxError);
    }
    if (typeof SharedArrayBuffer === 'function') {
        const shared = new SharedArrayBuffer(3);
        new Uint8Array(shared).set([97, 61, 49]);
        deepStrictEqual(TOML.parse(shared), { a: 1 });
        deepStrictEqual(TOML.parse(new Uint8Array(shared)), { a: 1 });
    }
    strictEqual(TOML.parse('value = "\ud800"').value, '\ufffd');
    strictEqual(TOML.stringify({ '\udc00': '\ud800' }), '"\ufffd" = "\ufffd"\n');
});

denoTest('dates and times use Temporal values', () => {
    const value = TOML.parse('date=1979-05-27\ntime=07:32:00.123456789123\nlocal=1979-05-27 07:32:00\noffset=1979-05-27T07:32:00.123456789+01:00');
    strictEqual(value.date.toString(), '1979-05-27');
    strictEqual(value.time.toString(), '07:32:00.123456789');
    strictEqual(value.local.toString(), '1979-05-27T07:32:00');
    strictEqual(value.offset.toString(), '1979-05-27T06:32:00.123456789Z');
    strictEqual(TOML.parse('time=07:32:00.120000000').time.toString(), '07:32:00.12');
    strictEqual(TOML.stringify(value), 'date = 1979-05-27\ntime = 07:32:00.123456789\nlocal = 1979-05-27T07:32:00\noffset = 1979-05-27T06:32:00.123456789Z\n');
});

denoTest('invalid documents and table redefinitions', () => {
    for (const source of ['a=01', 'a=1_', 'a=0xG', 'a=9007199254740992', 'a=1979-02-30', 'a="\\q"', 'a="unterminated', 'a=[1 2]', 'a=1\na=2', '[a]\n[a]', 'a.b=1\n[a]', '[a.b]\nx=1\n[a]\nb.c=2', 'a={b=1}\na.c=2', 'a=1\n[a]', 'a=1 #\x01', '#\x7f', 'a=1\r']) {
        throws(() => TOML.parse(source), SyntaxError, source);
    }
    for (const input of [null, undefined, Symbol()]) throws(() => TOML.parse(input), TypeError);
});

denoTest('stringify sections, arrays, keys and special values', () => {
    strictEqual(TOML.stringify({ name: 'hi', '\x7f': '\x7f', numbers: [1, -0, NaN, Infinity, -Infinity], missing: undefined, nested: { child: { ok: true } }, products: [{ name: 'a' }, { name: 'b' }] }), 'name = "hi"\n"\\u007f" = "\\u007f"\nnumbers = [1, -0.0, nan, inf, -inf]\n\n[nested.child]\nok = true\n\n[[products]]\nname = "a"\n\n[[products]]\nname = "b"\n');
    strictEqual(TOML.stringify({ inline: [{ a: 1 }, 2], empty: {} }), 'inline = [{ a = 1 }, 2]\n\n[empty]\n');
    strictEqual(TOML.stringify(undefined), undefined);
    strictEqual(TOML.stringify(Symbol()), undefined);
    strictEqual(TOML.stringify(() => {}), undefined);
    strictEqual(TOML.stringify({ a: 1 }, null, Symbol()), 'a = 1\n');
    throws(() => TOML.stringify({ a: 1 }, false), /does not support the replacer/);
    strictEqual(TOML.stringify({}), '');
    for (const value of [null, 1, [], 'x', new Date(), new String('x')]) throws(() => TOML.stringify(value));
    throws(() => TOML.stringify({ x: null }), /cannot represent null/);
    throws(() => TOML.stringify({ x: [undefined] }), /cannot represent undefined/);
    throws(() => TOML.stringify({ x: 1n }), /BigInt/);
    const cycle: any = {}; cycle.self = cycle;
    throws(() => TOML.stringify(cycle), /circular/);
});

function denoTest(name: string, fn: () => void) { Deno.test(`bun: TOML ${name}`, fn); }
