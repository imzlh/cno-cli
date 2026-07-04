import { strictEqual, ok } from 'node:assert';
import { StringDecoder } from 'node:string_decoder';

// --- 1. write decodes utf8 -----------------------------------------------

Deno.test('string_decoder: write decodes utf8', () => {
    const d = new StringDecoder('utf8');
    const out = d.write(Buffer.from('hello'));
    strictEqual(out, 'hello');
});

// --- 2. end flushes remaining bytes ----------------------------------------

Deno.test('string_decoder: end flushes', () => {
    const d = new StringDecoder('utf8');
    d.write(Buffer.from('hel'));
    const out = d.end(Buffer.from('lo'));
    strictEqual(out, 'lo');
});

// --- 3. multi-byte utf8 split across writes is reassembled -----------------

Deno.test('string_decoder: split multi-byte utf8 reassembled', () => {
    const d = new StringDecoder('utf8');
    // 'é' = 0xC3 0xA9; split across two writes
    const b1 = Buffer.from([0xc3]);
    const b2 = Buffer.from([0xa9]);
    const partial = d.write(b1);
    strictEqual(partial, '', 'incomplete multibyte must not emit');
    const rest = d.write(b2);
    strictEqual(rest, 'é');
});

// --- 4. utf8 with BOM ------------------------------------------------------

Deno.test('string_decoder: utf8 with BOM', () => {
    const d = new StringDecoder('utf8');
    const out = d.write(Buffer.from([0xEF, 0xBB, 0xBF, 0x68, 0x69]));
    ok(out.includes('hi'));
});

// --- 5. latin1 decoding ----------------------------------------------------

Deno.test('string_decoder: latin1 decoding', () => {
    const d = new StringDecoder('latin1');
    const out = d.write(Buffer.from([0xE9]));
    strictEqual(out, 'é');
});

// --- 6. hex encoding emits hex text ---------------------------------------

Deno.test('string_decoder: hex encoding', () => {
    const d = new StringDecoder('hex');
    const out = d.write(Buffer.from('68656c6c6f', 'hex'));
    strictEqual(out, '68656c6c6f');
});

// --- 7. ascii encoding -----------------------------------------------------

Deno.test('string_decoder: ascii encoding', () => {
    const d = new StringDecoder('ascii');
    const out = d.write(Buffer.from('abc'));
    strictEqual(out, 'abc');
});

// --- 8. end without pending bytes returns empty ---------------------------

Deno.test('string_decoder: end without pending returns empty', () => {
    const d = new StringDecoder('utf8');
    d.write(Buffer.from('x'));
    const out = d.end();
    strictEqual(out, '');
});

// --- 9. multiple writes then end ------------------------------------------

Deno.test('string_decoder: multiple writes then end', () => {
    const d = new StringDecoder('utf8');
    let s = '';
    s += d.write(Buffer.from('a'));
    s += d.write(Buffer.from('b'));
    s += d.write(Buffer.from('c'));
    s += d.end();
    strictEqual(s, 'abc');
});

// --- 10. default encoding is utf8 -----------------------------------------

Deno.test('string_decoder: default encoding utf8', () => {
    const d = new StringDecoder();
    const out = d.write(Buffer.from('hi'));
    strictEqual(out, 'hi');
});
