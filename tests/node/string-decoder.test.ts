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

// --- 11. end on incomplete utf8 flushes replacement char -------------------

Deno.test('string_decoder: end on incomplete utf8 emits replacement char', () => {
    const d = new StringDecoder('utf8');
    strictEqual(d.write(Buffer.from([0xe4, 0xb8])), '');
    strictEqual(d.end(), '\uFFFD');
});

// --- 12. decoder can be reused after end -----------------------------------

Deno.test('string_decoder: write works again after end resets decoder state', () => {
    const d = new StringDecoder('utf8');
    d.write(Buffer.from('a'));
    strictEqual(d.end(), '');
    strictEqual(d.write(Buffer.from('b')), 'b');
});

// --- 13. hex end with final buffer returns hex text -------------------------

Deno.test('string_decoder: hex end with buffer encodes final bytes as hex', () => {
    const d = new StringDecoder('hex');
    strictEqual(d.end(Buffer.from('ab')), '6162');
});

Deno.test('string_decoder: base64 buffers incomplete output until end', () => {
    const d = new StringDecoder('base64');
    strictEqual(d.write(Buffer.from('hi')), '');
    strictEqual(d.end(), 'aGk=');
});

Deno.test('string_decoder: base64 emits only complete triplets across writes', () => {
    const d = new StringDecoder('base64');
    strictEqual(d.write(Buffer.from('f')), '');
    strictEqual(d.write(Buffer.from('oo')), 'Zm9v');
    strictEqual(d.write(Buffer.from('ba')), '');
    strictEqual(d.write(Buffer.from('r')), 'YmFy');
    strictEqual(d.end(), '');
});

Deno.test('string_decoder upstream: incomplete byte sequences match Node output', () => {
    const cases: Array<{
        encoding: BufferEncoding;
        chunks: Array<[string, Buffer]>;
        end: string;
    }> = [
        {
            encoding: 'utf8',
            chunks: [['', Buffer.from('E1', 'hex')]],
            end: '\ufffd',
        },
        {
            encoding: 'utf8',
            chunks: [['', Buffer.from('E18B', 'hex')]],
            end: '\ufffd',
        },
        {
            encoding: 'utf8',
            chunks: [['\ufffd', Buffer.from('\ufffd')]],
            end: '',
        },
        {
            encoding: 'utf8',
            chunks: [['\ufffd', Buffer.from('EFBFBDE2', 'hex')]],
            end: '\ufffd',
        },
        {
            encoding: 'utf8',
            chunks: [
                ['', Buffer.from('F1', 'hex')],
                ['\ufffdA', Buffer.from('41F2', 'hex')],
            ],
            end: '\ufffd',
        },
        {
            encoding: 'base64',
            chunks: [['', Buffer.from('E18B', 'hex')]],
            end: '4Ys=',
        },
        {
            encoding: 'base64',
            chunks: [['77+9', Buffer.from('EFBFBDE2', 'hex')]],
            end: '4g==',
        },
        {
            encoding: 'hex',
            chunks: [['efbfbde2', Buffer.from('EFBFBDE2', 'hex')]],
            end: '',
        },
    ];

    for (const { encoding, chunks, end } of cases) {
        const decoder = new StringDecoder(encoding);
        for (const [expected, chunk] of chunks) {
            strictEqual(decoder.write(chunk), expected);
        }
        strictEqual(decoder.end(), end);
    }
});

Deno.test('string_decoder upstream: base64url buffers and omits padding', () => {
    let d = new StringDecoder('base64url');
    strictEqual(d.write(Buffer.from('E1', 'hex')), '');
    strictEqual(d.end(), '4Q');

    d = new StringDecoder('base64url');
    strictEqual(d.write(Buffer.from('\ufffd')), '77-9');
    strictEqual(d.end(), '');

    d = new StringDecoder('base64url');
    strictEqual(d.write(Buffer.from('EFBFBDE2', 'hex')), '77-9');
    strictEqual(d.end(), '4g');

    d = new StringDecoder('base64url');
    strictEqual(d.write(Buffer.from('F1', 'hex')), '');
    strictEqual(d.write(Buffer.from('41F2', 'hex')), '8UHy');
    strictEqual(d.end(), '');
});

Deno.test('string_decoder: utf16le split code units are reassembled across writes', () => {
    const d = new StringDecoder('utf16le');
    const bytes = Buffer.from('A🙂B', 'utf16le');
    strictEqual(d.write(bytes.subarray(0, 3)), 'A');
    strictEqual(d.write(bytes.subarray(3, 7)), '🙂');
    strictEqual(d.end(bytes.subarray(7)), 'B');
});

Deno.test('string_decoder: constructor can initialize subclass-style instances', () => {
    function LegacyDecoder(this: any) {
        StringDecoder.call(this, 'utf8');
    }
    LegacyDecoder.prototype = Object.create(StringDecoder.prototype);
    LegacyDecoder.prototype.constructor = LegacyDecoder;

    const decoder = new (LegacyDecoder as any)() as StringDecoder;
    strictEqual(decoder.write(Buffer.from([0xe4, 0xb8])), '');
    strictEqual(decoder.end(Buffer.from([0xad])), '中');
});
