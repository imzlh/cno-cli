import { strictEqual, ok, deepStrictEqual } from 'node:assert';

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
    strictEqual(new TextDecoder().decode(buf), 'abc');
});

// --- 12. Blob bytes() returns Uint8Array --------------------------------

Deno.test('Blob: bytes() returns Uint8Array', async () => {
    const b = new Blob(['xyz']);
    const arr = await b.bytes();
    ok(arr instanceof Uint8Array);
    strictEqual(new TextDecoder().decode(arr), 'xyz');
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
