import { strictEqual, ok, deepStrictEqual, throws } from 'node:assert';
import { decodeUtf8 } from '../_helpers/bytes.ts';

// ============================================================================
// FormData / Blob / File
// ============================================================================

// --- 1. FormData append + get + getAll ------------------------------------

Deno.test('FormData: append string then get', () => {
    const fd = new FormData();
    fd.append('a', '1');
    fd.append('a', '2');
    strictEqual(fd.get('a'), '1');
    deepStrictEqual(fd.getAll('a'), ['1', '2']);
});

// --- 2. FormData set replaces all -----------------------------------------

Deno.test('FormData: set replaces all values for a key', () => {
    const fd = new FormData();
    fd.append('a', '1');
    fd.append('a', '2');
    fd.set('a', 'only');
    deepStrictEqual(fd.getAll('a'), ['only']);
});

// --- 3. FormData delete ---------------------------------------------------

Deno.test('FormData: delete removes all values for a key', () => {
    const fd = new FormData();
    fd.append('a', '1');
    fd.append('b', '2');
    fd.delete('a');
    ok(!fd.has('a'));
    ok(fd.has('b'));
});

// --- 4. FormData has -----------------------------------------------------

Deno.test('FormData: has checks existence', () => {
    const fd = new FormData();
    fd.append('a', '1');
    ok(fd.has('a'));
    ok(!fd.has('z'));
});

// --- 5. FormData append Blob becomes File ---------------------------------

Deno.test('FormData: append Blob with filename becomes File', () => {
    const fd = new FormData();
    const blob = new Blob(['content'], { type: 'text/plain' });
    fd.append('f', blob, 'name.txt');
    const entry = fd.get('f');
    ok(entry instanceof File, 'Blob appended with filename must be a File');
    strictEqual((entry as File).name, 'name.txt');
});

// --- 6. FormData iteration: entries/keys/values --------------------------

Deno.test('FormData: entries/keys/values iteration', () => {
    const fd = new FormData();
    fd.append('a', '1');
    fd.append('b', '2');
    const entries = [...fd.entries()];
    const keys = [...fd.keys()];
    const values = [...fd.values()];
    deepStrictEqual(entries.map(([k, v]) => `${k}=${v}`).sort(), ['a=1', 'b=2']);
    deepStrictEqual(keys.sort(), ['a', 'b']);
    deepStrictEqual(values.sort(), ['1', '2']);
});

// --- 7. Blob size + type --------------------------------------------------

Deno.test('Blob: size and type reflect input', () => {
    const b = new Blob(['hello'], { type: 'text/plain' });
    strictEqual(b.size, 5);
    strictEqual(b.type, 'text/plain');
});

// --- 8. Blob slice --------------------------------------------------------

Deno.test('Blob: slice returns sub-range', async () => {
    const b = new Blob(['abcdef']);
    const s = b.slice(1, 4);
    strictEqual(s.size, 3);
    strictEqual(await s.text(), 'bcd');
});

// --- 9. Blob slice with contentType --------------------------------------

Deno.test('Blob: slice with contentType overrides type', () => {
    const b = new Blob(['x'], { type: 'text/plain' });
    const s = b.slice(0, 1, 'application/json');
    strictEqual(s.type, 'application/json');
});

// --- 10. Blob text() decodes utf8 ----------------------------------------

Deno.test('Blob: text() decodes utf8', async () => {
    const b = new Blob(['café']);
    strictEqual(await b.text(), 'café');
});

// --- 11. Blob arrayBuffer() returns bytes --------------------------------

Deno.test('Blob: arrayBuffer() returns raw bytes', async () => {
    const b = new Blob(['abc']);
    const buf = await b.arrayBuffer();
    strictEqual(decodeUtf8(buf), 'abc');
});

// --- 12. Blob bytes() returns Uint8Array --------------------------------

Deno.test('Blob: bytes() returns Uint8Array', async () => {
    const b = new Blob(['xyz']);
    const arr = await b.bytes();
    ok(arr instanceof Uint8Array);
    strictEqual(decodeUtf8(arr), 'xyz');
});

// --- 13. Blob stream() is a ReadableStream -------------------------------

Deno.test('Blob: stream() returns a ReadableStream', async () => {
    const b = new Blob(['stream-data']);
    const rs = b.stream();
    ok(rs instanceof ReadableStream);
    const text = await new Response(rs).text();
    strictEqual(text, 'stream-data');
});

// --- 14. File has name + lastModified ------------------------------------

Deno.test('File: name and lastModified', () => {
    const f = new File(['data'], 'report.txt', { type: 'text/plain', lastModified: 1234567890000 });
    strictEqual(f.name, 'report.txt');
    strictEqual(f.type, 'text/plain');
    strictEqual(f.size, 4);
    ok(f.lastModified > 0);
});

// --- 15. File is a Blob subclass ------------------------------------------

Deno.test('File extends Blob', () => {
    const f = new File(['x'], 'a.txt');
    ok(f instanceof Blob);
    ok(f instanceof File);
});

// --- 16. Blob from multiple parts ----------------------------------------

Deno.test('Blob: multiple parts concatenate', async () => {
    const b = new Blob(['hello', ' ', 'world']);
    strictEqual(await b.text(), 'hello world');
    strictEqual(b.size, 11);
});

// --- 17. Blob empty -------------------------------------------------------

Deno.test('Blob: empty blob has size 0', () => {
    const b = new Blob([]);
    strictEqual(b.size, 0);
    strictEqual(b.type, '');
});

// --- 18. Blob type normalization (charset stripped) ----------------------

Deno.test('Blob: type is lowercased and normalized', () => {
    const b = new Blob(['x'], { type: 'TEXT/Plain; charset=utf-8' });
    ok(b.type.startsWith('text/plain'));
});

Deno.test('Blob upstream: constructor snapshots binary parts and coerces objects once', async () => {
    const typed = new Uint8Array([65, 66, 67, 68]);
    const view = new DataView(typed.buffer, 1, 2);
    const blobFromView = new Blob([view]);
    typed[1] = 120;
    typed[2] = 121;
    strictEqual(await blobFromView.text(), 'BC');

    const buffer = new ArrayBuffer(3);
    const bufferBytes = new Uint8Array(buffer);
    bufferBytes.set([49, 50, 51]);
    const blobFromBuffer = new Blob([buffer]);
    bufferBytes[0] = 57;
    strictEqual(await blobFromBuffer.text(), '123');

    const object = { value: 'before', toString() { return this.value; } };
    const blobFromObject = new Blob([object as unknown as BlobPart]);
    object.value = 'after';
    strictEqual(await blobFromObject.text(), 'before');
});

Deno.test('Blob upstream: constructor accepts nested blobs buffers and unusual options objects', async () => {
    const buffer = new ArrayBuffer(12);
    const bytes = new Uint8Array(buffer);
    const floats = new Float32Array(buffer);
    const blobFromBufferAndView = new Blob([buffer, bytes]);
    strictEqual(blobFromBufferAndView.size, 2 * bytes.length);

    const nested = new Blob([blobFromBufferAndView, floats]);
    strictEqual(nested.size, 3 * bytes.length);

    const hasOwnPropertyOption = {
        ending: 'utf8',
        hasOwnProperty: 'hasOwnProperty',
    };
    strictEqual(new Blob(['Hello World'], hasOwnPropertyOption as BlobPropertyBag).size, 11);
    strictEqual(new Blob(['Hello World'], Object.create(null)).size, 11);
    strictEqual(new Blob().constructor.name, 'Blob');
    strictEqual(await new Blob([new Blob(['Hello']), ' World']).text(), 'Hello World');
});

Deno.test('Blob upstream: slice supports negative indexes and rejects invalid content type', async () => {
    const blob = new Blob(['Deno', 'Foo'], { type: 'text/plain' });
    const sliced = blob.slice(-5, -2, 'Text/HTML');
    strictEqual(sliced.size, 3);
    strictEqual(sliced.type, 'text/html');
    strictEqual(await sliced.text(), 'noF');

    const invalidType = blob.slice(0, 1, 'text/plain\nbad');
    strictEqual(invalidType.type, '');
});

Deno.test('File upstream: constructor coerces file bits and names like Blob', async () => {
    const file = new File([123, ['x', 'y'] as unknown as BlobPart, { toString: () => 'obj' } as unknown as BlobPart], null as unknown as string);
    strictEqual(file.name, 'null');
    strictEqual(file.type, '');
    strictEqual(file.size, 9);
    strictEqual(await file.text(), '123x,yobj');

    const typed = new Uint8Array([97, 98]);
    const fromTyped = new File([typed], 42 as unknown as string);
    typed[0] = 99;
    strictEqual(fromTyped.name, '42');
    strictEqual(await fromTyped.text(), 'ab');
});

Deno.test('FormData upstream: methods validate required arguments and callback', () => {
    const fd = new FormData();

    throws(() => Reflect.apply(FormData.prototype.append, fd, ['a']), TypeError);
    throws(() => Reflect.apply(FormData.prototype.set, fd, ['a']), TypeError);
    throws(() => fd.append('a', 'value', 'name.txt'), TypeError);
    throws(() => fd.set('a', 'value', 'name.txt'), TypeError);
    throws(() => Reflect.apply(FormData.prototype.delete, fd, []), TypeError);
    throws(() => Reflect.apply(FormData.prototype.get, fd, []), TypeError);
    throws(() => Reflect.apply(FormData.prototype.getAll, fd, []), TypeError);
    throws(() => Reflect.apply(FormData.prototype.has, fd, []), TypeError);
    throws(() => Reflect.apply(FormData.prototype.forEach, fd, []), TypeError);
    throws(() => Reflect.apply(FormData.prototype.forEach, fd, [null]), TypeError);
});

Deno.test('FormData upstream: filename override accepts empty string for File values', () => {
    const fd = new FormData();
    const file = new File(['content'], 'original.txt', { type: 'text/plain' });

    fd.append('file', file, '');
    const appended = fd.get('file');
    ok(appended instanceof File);
    strictEqual(appended.name, '');
    strictEqual(appended.type, 'text/plain');

    fd.set('file', file, 'renamed.txt');
    const renamed = fd.get('file');
    ok(renamed instanceof File);
    strictEqual(renamed.name, 'renamed.txt');
});

Deno.test('FormData upstream: forEach uses thisArg parent and live entries', () => {
    const fd = new FormData();
    const context = { name: 'ctx' };
    const seen: string[] = [];

    fd.append('a', '1');
    fd.append('b', '2');
    fd.forEach(function (this: typeof context, value, key, parent) {
        strictEqual(this, context);
        strictEqual(parent, fd);
        seen.push(`${key}:${value}`);
        if (key === 'a') {
            fd.delete('b');
            fd.append('c', '3');
        }
    }, context);

    deepStrictEqual(seen, ['a:1', 'c:3']);
});

Deno.test('Blob upstream: endings option normalizes only string parts', async () => {
    const source = 'a\rb\r\nc\nd';
    const native = Deno.build.os === 'windows' ? 'a\r\nb\r\nc\r\nd' : 'a\nb\nc\nd';
    strictEqual(await new Blob([source], { endings: 'transparent' }).text(), source);
    strictEqual(await new Blob([source], { endings: 'native' }).text(), native);

    const bytes = new Uint8Array([13, 10]);
    strictEqual(await new Blob([bytes], { endings: 'native' }).text(), '\r\n');
    throws(() => new Blob([], { endings: 'invalid' as EndingType }), TypeError);
});

Deno.test('Blob upstream: stream reads are independent', async () => {
    const blob = new Blob(['read twice']);
    strictEqual(await new Response(blob.stream()).text(), 'read twice');
    strictEqual(await new Response(blob.stream()).text(), 'read twice');
});

Deno.test('File upstream: constructor metadata defaults and string tag', async () => {
    throws(() => Reflect.construct(File, [[]]), TypeError);

    const before = Date.now();
    const file = new File(['bits'], 'name.txt', { type: 'TEXT/PLAIN', lastModified: 123 });
    const defaultModified = new File([], 'empty');
    const after = Date.now();

    strictEqual(file.type, 'text/plain');
    strictEqual(file.lastModified, 123);
    strictEqual(file.webkitRelativePath, '');
    strictEqual(Object.prototype.toString.call(file), '[object File]');
    ok(defaultModified.lastModified >= before);
    ok(defaultModified.lastModified <= after);
    strictEqual(await file.text(), 'bits');
});
