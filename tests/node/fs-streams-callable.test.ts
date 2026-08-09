import { ok, strictEqual } from 'node:assert';
import * as fs from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

// fs.ReadStream / fs.WriteStream must be callable WITHOUT `new`.
//
// Node's are ES5-style constructors, so the ecosystem subclasses them the ES5
// way. `graceful-fs` -- a transitive dependency of fs-extra, archiver, tar-fs and
// npm itself -- does exactly that (graceful-fs.js:297):
//
//     function ReadStream (path, options) {
//       if (this instanceof ReadStream)
//         return fs$ReadStream.apply(this, arguments), this
//       else
//         return ReadStream.apply(Object.create(ReadStream.prototype), arguments)
//     }
//
// Against a `class`, that `.apply` throws "class constructors must be invoked
// with 'new'". Every fs.createReadStream routed through graceful-fs died, so
// `archiver` and `tar-stream` produced NO OUTPUT AT ALL under cno while node
// wrote complete archives -- found by running those packages, not by probing the
// API, because `new fs.ReadStream(...)` works fine and hides it.
//
// The fix must run the init against the CALLER'S object, not construct a copy:
// the async open closes over whatever object it was handed, so copying own
// properties across leaves the caller's stream with a null handle, and it hangs
// with zero bytes and no 'end' -- a silent failure worse than the throw.

function tempFile(name: string, contents: string): string {
    const dir = fs.mkdtempSync(join(tmpdir(), 'cno-fs-callable-'));
    const file = join(dir, name);
    fs.writeFileSync(file, contents);
    return file;
}

function readAll(stream: fs.ReadStream): Promise<string> {
    return new Promise((resolve, reject) => {
        const chunks: Buffer[] = [];
        stream.on('data', (chunk) => chunks.push(Buffer.from(chunk as Uint8Array)));
        stream.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
        stream.on('error', reject);
    });
}

Deno.test('fs.ReadStream is callable without new', async () => {
    const file = tempFile('bare.txt', 'bare-call-contents');
    const stream = (fs.ReadStream as unknown as (p: string) => fs.ReadStream)(file);
    ok(stream instanceof fs.ReadStream, 'a bare call still yields a ReadStream');
    strictEqual(await readAll(stream), 'bare-call-contents');
});

Deno.test('fs.WriteStream is callable without new', async () => {
    const file = tempFile('bare-w.txt', '');
    const stream = (fs.WriteStream as unknown as (p: string) => fs.WriteStream)(file);
    ok(stream instanceof fs.WriteStream);
    await new Promise<void>((resolve, reject) => {
        stream.on('error', reject);
        stream.end('written-without-new', () => resolve());
    });
    strictEqual(fs.readFileSync(file, 'utf8'), 'written-without-new');
});

Deno.test('constructor.name is ReadStream, not the internal class name', () => {
    // The facade keeps the class's prototype, so `constructor` resolves to the
    // class -- whose name would otherwise leak as 'ReadStreamClass' to anything
    // that reports or switches on it.
    const file = tempFile('name.txt', 'x');
    const stream = fs.createReadStream(file);
    strictEqual(stream.constructor.name, 'ReadStream');
    stream.destroy();
    const ws = fs.createWriteStream(join(join(file, '..'), 'name-w.txt'));
    strictEqual(ws.constructor.name, 'WriteStream');
    ws.destroy();
});

Deno.test('ReadStream.apply initializes a caller-supplied object in place', async () => {
    // Node's exact measured semantics: `.apply(o, args)` on a prototype-linked o
    // initializes o and the caller keeps using o. The returned value is NOT the
    // object -- graceful-fs discards it and returns its own `this` -- so the
    // assertion that matters is that `o` itself became a working stream.
    const file = tempFile('applied.txt', 'applied-contents');
    const target = Object.create(fs.ReadStream.prototype) as fs.ReadStream;
    (fs.ReadStream as unknown as { apply(t: unknown, a: unknown[]): unknown }).apply(target, [file]);

    strictEqual(target.path, file, 'the caller-supplied object was initialized');
    // The load-bearing part: reading must work THROUGH the caller's object. If
    // the init ran against a copy, target.handle stays null and this hangs.
    strictEqual(await readAll(target), 'applied-contents');
});

Deno.test('the graceful-fs ES5 subclass pattern reads a file end to end', async () => {
    // The actual failing shape, reproduced without depending on the package.
    const file = tempFile('graceful.txt', 'graceful-fs-contents');

    function LegacyReadStream(this: unknown, path: string, options?: object): unknown {
        if (this instanceof LegacyReadStream) {
            (fs.ReadStream as unknown as { apply(t: unknown, a: unknown[]): unknown }).apply(this, [path, options]);
            return this;
        }
        return (LegacyReadStream as unknown as { apply(t: unknown, a: unknown[]): unknown })
            .apply(Object.create(LegacyReadStream.prototype), [path, options]);
    }
    LegacyReadStream.prototype = Object.create(fs.ReadStream.prototype);

    const viaNew = new (LegacyReadStream as unknown as new (p: string) => fs.ReadStream)(file);
    ok(viaNew instanceof fs.ReadStream, 'an ES5 subclass instance is still a ReadStream');
    strictEqual(await readAll(viaNew), 'graceful-fs-contents');

    // graceful-fs also relies on the no-new branch returning a usable stream.
    const viaCall = (LegacyReadStream as unknown as (p: string) => fs.ReadStream)(file);
    strictEqual(await readAll(viaCall), 'graceful-fs-contents');
});

Deno.test('WriteStream.apply initializes a caller-supplied object in place', async () => {
    const dir = fs.mkdtempSync(join(tmpdir(), 'cno-fs-callable-w-'));
    const file = join(dir, 'applied-w.txt');
    const target = Object.create(fs.WriteStream.prototype) as fs.WriteStream;
    (fs.WriteStream as unknown as { apply(t: unknown, a: unknown[]): unknown }).apply(target, [file]);

    strictEqual(target.path, file);
    await new Promise<void>((resolve, reject) => {
        target.on('error', reject);
        target.end('applied-write', () => resolve());
    });
    strictEqual(fs.readFileSync(file, 'utf8'), 'applied-write');
});

Deno.test('options still apply on the no-new path', async () => {
    // start/end must be honoured however the stream was constructed, or the
    // facade silently drops arguments the class path respects.
    const file = tempFile('sliced.txt', 'ABCDEFGHIJ');
    const stream = (fs.ReadStream as unknown as (p: string, o: object) => fs.ReadStream)(file, { start: 2, end: 5 });
    strictEqual(await readAll(stream), 'CDEF');
});

Deno.test('FileReadStream and FileWriteStream stay aliases', () => {
    strictEqual((fs as unknown as { FileReadStream: unknown }).FileReadStream, fs.ReadStream);
    strictEqual((fs as unknown as { FileWriteStream: unknown }).FileWriteStream, fs.WriteStream);
});
