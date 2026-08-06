import { strictEqual, deepStrictEqual } from 'node:assert';
import * as fs from 'node:fs';
import { open } from 'node:fs/promises';
import { join } from 'node:path';
import { withTempDir } from '../_helpers/temp.ts';

// Node accepts any ArrayBufferView (incl. DataView / non-Uint8Array TypedArray)
// as an fd read/write buffer and treats it as raw bytes over its own window.
// `new Uint8Array(dataView)` is length 0 and `dataView.subarray` does not exist,
// so these paths must normalise via buffer/byteOffset/byteLength.
const DATA = Uint8Array.from([0xaa, 0xbb, 0xcc, 0xdd, 0xee, 0xef, 0xf0, 0xf1]);

/** 16-byte backing store; the caller's window is bytes [4, 8). */
function windowed(kind: 'u8' | 'dv' | 'u16'): { backing: Uint8Array; view: ArrayBufferView } {
    const backing = new Uint8Array(16);
    const view = kind === 'u8' ? backing.subarray(4, 8)
        : kind === 'dv' ? new DataView(backing.buffer, 4, 4)
        : new Uint16Array(backing.buffer, 4, 2);
    return { backing, view };
}

const KINDS: Array<'u8' | 'dv' | 'u16'> = ['u8', 'dv', 'u16'];
const expectedBacking = () => {
    const e = new Uint8Array(16);
    e.set([0xaa, 0xbb, 0xcc, 0xdd], 4);
    return e;
};

Deno.test('fs.readSync fills the exact window of any ArrayBufferView', async () => {
    await withTempDir('fs-view-read-sync', async (root) => {
        const file = join(root, 'src.bin');
        fs.writeFileSync(file, DATA);
        for (const kind of KINDS) {
            const { backing, view } = windowed(kind);
            const fd = fs.openSync(file, 'r');
            try {
                strictEqual(fs.readSync(fd, view, 0, 4, 0), 4, kind);
            } finally { fs.closeSync(fd); }
            deepStrictEqual(backing, expectedBacking(), kind);
        }
    });
});

Deno.test('fs.readSync(fd, buffer) 2-arg form reads the whole buffer', async () => {
    await withTempDir('fs-view-read-2arg', async (root) => {
        const file = join(root, 'src.bin');
        fs.writeFileSync(file, DATA);
        // Regression: offset/length were passed straight to subarray(), so the
        // 2-arg form became subarray(undefined, NaN) and silently read 0 bytes.
        const buf = new Uint8Array(8);
        const fd = fs.openSync(file, 'r');
        try {
            strictEqual(fs.readSync(fd, buf), 8);
        } finally { fs.closeSync(fd); }
        deepStrictEqual(buf, DATA);
    });
});

Deno.test('fs.readSync supports the options-object form', async () => {
    await withTempDir('fs-view-read-options', async (root) => {
        const file = join(root, 'src.bin');
        fs.writeFileSync(file, DATA);
        const fd = fs.openSync(file, 'r');
        try {
            const a = new Uint8Array(8);
            strictEqual(fs.readSync(fd, a, {}), 8);
            deepStrictEqual(a, DATA);

            const b = new Uint8Array(8);
            strictEqual(fs.readSync(fd, b, { offset: 2, length: 4, position: 0 }), 4);
            deepStrictEqual(b, Uint8Array.from([0, 0, 0xaa, 0xbb, 0xcc, 0xdd, 0, 0]));

            const c = new Uint8Array(8);
            strictEqual(fs.readSync(fd, c, { position: 4 }), 4);
            deepStrictEqual(c, Uint8Array.from([0xee, 0xef, 0xf0, 0xf1, 0, 0, 0, 0]));
        } finally { fs.closeSync(fd); }
    });
});

Deno.test('fs.writeSync writes the exact window of any ArrayBufferView', async () => {
    await withTempDir('fs-view-write-sync', async (root) => {
        for (const kind of KINDS) {
            const { backing, view } = windowed(kind);
            new Uint8Array(backing.buffer, 4, 4).set([1, 2, 3, 4]);
            const file = join(root, `out-${kind}.bin`);
            const fd = fs.openSync(file, 'w');
            try { fs.writeSync(fd, view); } finally { fs.closeSync(fd); }
            deepStrictEqual(fs.readFileSync(file), Buffer.from([1, 2, 3, 4]), kind);
        }
    });
});

Deno.test('fs.writeSync supports the options-object form', async () => {
    await withTempDir('fs-view-write-options', async (root) => {
        const file = join(root, 'out.bin');
        const fd = fs.openSync(file, 'w');
        try {
            fs.writeSync(fd, Uint8Array.from([1, 2, 3, 4, 5, 6, 7, 8]), { offset: 2, length: 4 });
        } finally { fs.closeSync(fd); }
        deepStrictEqual(fs.readFileSync(file), Buffer.from([3, 4, 5, 6]));
    });
});

Deno.test('fs.writeSync with a null offset writes the whole buffer', async () => {
    await withTempDir('fs-view-write-nulloffset', async (root) => {
        // Node resets BOTH offset and length when offset is not an integer.
        const file = join(root, 'out.bin');
        const fd = fs.openSync(file, 'w');
        try {
            fs.writeSync(fd, Uint8Array.from([1, 2, 3, 4, 5, 6, 7, 8]), null, 4);
        } finally { fs.closeSync(fd); }
        deepStrictEqual(fs.readFileSync(file), Buffer.from([1, 2, 3, 4, 5, 6, 7, 8]));
    });
});

Deno.test('fs.read accepts the (buffer, cb) and (buffer, options, cb) forms', async () => {
    await withTempDir('fs-view-read-async', async (root) => {
        const file = join(root, 'src.bin');
        fs.writeFileSync(file, DATA);

        const readAsync = (args: unknown[]) => new Promise<{ n: number; buf: Uint8Array }>((res, rej) => {
            const buf = new Uint8Array(8);
            const fd = fs.openSync(file, 'r');
            // @ts-expect-error variadic Node overloads
            fs.read(fd, buf, ...args, (err: Error | null, n: number) => {
                fs.closeSync(fd);
                err ? rej(err) : res({ n, buf });
            });
        });

        const bare = await readAsync([]);
        strictEqual(bare.n, 8);
        deepStrictEqual(bare.buf, DATA);

        const opts = await readAsync([{ offset: 2, length: 4, position: 0 }]);
        strictEqual(opts.n, 4);
        deepStrictEqual(opts.buf, Uint8Array.from([0, 0, 0xaa, 0xbb, 0xcc, 0xdd, 0, 0]));
    });
});

Deno.test('fs.read fills the exact window of a DataView', async () => {
    await withTempDir('fs-view-read-async-dv', async (root) => {
        const file = join(root, 'src.bin');
        fs.writeFileSync(file, DATA);
        const { backing, view } = windowed('dv');
        const n = await new Promise<number>((res, rej) => {
            const fd = fs.openSync(file, 'r');
            fs.read(fd, view as unknown as Uint8Array, 0, 4, 0, (err, bytes) => {
                fs.closeSync(fd);
                err ? rej(err) : res(bytes);
            });
        });
        strictEqual(n, 4);
        deepStrictEqual(backing, expectedBacking());
    });
});

Deno.test('FileHandle.read/write honour views, options and the no-arg form', async () => {
    await withTempDir('fs-view-filehandle', async (root) => {
        const file = join(root, 'src.bin');
        fs.writeFileSync(file, DATA);

        for (const kind of KINDS) {
            const { backing, view } = windowed(kind);
            const fh = await open(file, 'r');
            try {
                const r = await fh.read(view as unknown as Uint8Array, 0, 4, 0);
                strictEqual(r.bytesRead, 4, kind);
            } finally { await fh.close().catch(() => {}); }
            deepStrictEqual(backing, expectedBacking(), kind);
        }

        // options-object form
        const fh2 = await open(file, 'r');
        try {
            const buf = new Uint8Array(8);
            const r = await fh2.read({ buffer: buf, offset: 2, length: 4, position: 0 });
            strictEqual(r.bytesRead, 4);
            deepStrictEqual(buf, Uint8Array.from([0, 0, 0xaa, 0xbb, 0xcc, 0xdd, 0, 0]));
        } finally { await fh2.close().catch(() => {}); }

        // no-arg form allocates its own 16 KiB buffer
        const fh3 = await open(file, 'r');
        try {
            const r = await fh3.read();
            strictEqual(r.bytesRead, 8);
            strictEqual(r.buffer.byteLength, 16384);
        } finally { await fh3.close().catch(() => {}); }

        // write from a DataView window
        const { backing, view } = windowed('dv');
        new Uint8Array(backing.buffer, 4, 4).set([9, 8, 7, 6]);
        const out = join(root, 'out.bin');
        const fh4 = await open(out, 'w');
        try {
            const w = await fh4.write(view as unknown as Uint8Array);
            strictEqual(w.bytesWritten, 4);
        } finally { await fh4.close().catch(() => {}); }
        deepStrictEqual(fs.readFileSync(out), Buffer.from([9, 8, 7, 6]));
    });
});
