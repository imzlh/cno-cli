/*
 * node:wasi -- fd bookkeeping, filetype reporting, stdio redirection, and the
 * start()/initialize() state machine.
 *
 * Measured against node v24.18.0. What these lock down (all were wrong before):
 *  - fd_read ignored options.stdin: it read the raw host fd 0 instead of the
 *    configured descriptor, so a redirected stdin returned 0 bytes with errno 0
 *    -- a silent EOF rather than the data. fd_write already mapped 1/2 onto
 *    _stdout/_stderr, so only the read direction was wrong.
 *  - The filetype enum was off by one: directory was reported as 2
 *    (character_device) and a regular file as 3 (directory), so a guest that
 *    checks filetype before recursing saw every file as a directory.
 *    preview1 witx: 0 unknown, 1 block_device, 2 character_device,
 *    3 directory, 4 regular_file, 5 socket_dgram, 6 socket_stream,
 *    7 symbolic_link.
 *  - fd_fdstat_get returned 0 (success) for ANY fd, including one never
 *    granted, leaving the stat buffer holding whatever was already in memory.
 *  - fd_close on an arbitrary integer reached the UCRT _close(), which asserts
 *    on an out-of-range handle: fd_close(9999) printed
 *    "close.cpp(55) : Assertion failed: (fh >= 0 && ...)".
 *  - initialize() checked the already-started flag but never set it, so
 *    initialize() followed by start() ran both entry points on one instance.
 *  - start() did not validate the command-module contract, so a reactor module
 *    with no _start surfaced as returnOnExit code 1 -- indistinguishable from a
 *    guest that really exited 1.
 */
import { strictEqual, ok, throws } from 'node:assert';
import { WASI } from 'node:wasi';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

/* ---- minimal wasm emitter (no toolchain needed) ---- */
function uleb(n: number): number[] {
    const out: number[] = [];
    let v = n >>> 0;
    do { let b = v & 0x7f; v >>>= 7; if (v !== 0) b |= 0x80; out.push(b); } while (v !== 0);
    return out;
}
function sleb(n: number): number[] {
    const out: number[] = [];
    let v = BigInt(n);
    for (;;) {
        const b = Number(v & 0x7fn);
        v >>= 7n;
        const sign = (b & 0x40) !== 0;
        if ((v === 0n && !sign) || (v === -1n && sign)) { out.push(b); break; }
        out.push(b | 0x80);
    }
    return out;
}
function str(s: string): number[] {
    const b = [...new TextEncoder().encode(s)];
    return [...uleb(b.length), ...b];
}
function vec(items: number[][]): number[] { return [...uleb(items.length), ...items.flat()]; }
function section(id: number, payload: number[]): number[] { return [id, ...uleb(payload.length), ...payload]; }
function body(locals: number[][], code: number[]): number[] {
    const inner = [...vec(locals), ...code, 0x0b];
    return [...uleb(inner.length), ...inner];
}
const I32 = 0x7f, I64 = 0x7e;
const MAGIC = [0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00];
const ftype = (p: number[], r: number[]): number[] => [0x60, ...vec(p.map(x => [x])), ...vec(r.map(x => [x]))];
const W = 'wasi_snapshot_preview1';

/*
 * A probe module that re-exports the WASI calls it imports, so the host can
 * drive each syscall with arbitrary arguments instead of baking one scenario
 * into the wasm. `entry` is the exported entry point name.
 */
interface Probe {
    memory: WebAssembly.Memory;
    w_path_open: (dirfd: number, dirflags: number, p: number, plen: number, oflags: number, base: bigint, inh: bigint, fdflags: number, fdOut: number) => number;
    w_fd_read: (fd: number, iovs: number, iovsLen: number, nreadOut: number) => number;
    w_fd_close: (fd: number) => number;
    w_fd_fdstat_get: (fd: number, out: number) => number;
    w_path_filestat_get: (dirfd: number, flags: number, p: number, plen: number, out: number) => number;
    [k: string]: unknown;
}
function buildProbe(entry: string): Uint8Array {
    /* import order fixes the func indices: 0..4 imports, then locals. */
    const sigs = [
        ftype([I32, I32, I32, I32, I32, I64, I64, I32, I32], [I32]), // 0 path_open
        ftype([I32, I32, I32, I32], [I32]),                          // 1 fd_read
        ftype([I32], [I32]),                                         // 2 fd_close
        ftype([I32, I32], [I32]),                                    // 3 fd_fdstat_get
        ftype([I32, I32, I32, I32, I32], [I32]),                     // 4 path_filestat_get
        ftype([], []),                                               // 5 entry
    ];
    const imports = [
        [...str(W), ...str('path_open'), 0x00, 0],
        [...str(W), ...str('fd_read'), 0x00, 1],
        [...str(W), ...str('fd_close'), 0x00, 2],
        [...str(W), ...str('fd_fdstat_get'), 0x00, 3],
        [...str(W), ...str('path_filestat_get'), 0x00, 4],
    ];
    /* Forwarding wrapper: push every param in order, then call the import. */
    const fwd = (nparams: number, target: number): number[] => {
        const code: number[] = [];
        for (let i = 0; i < nparams; i++) code.push(0x20, ...uleb(i));
        code.push(0x10, ...uleb(target));
        return body([], code);
    };
    const parts = [
        section(1, vec(sigs)),
        section(2, vec(imports)),
        section(3, vec([[0], [1], [2], [3], [4], [5]])),  // 6 local funcs, types in order
        section(5, vec([[0x00, 2]])),                     // memory, 2 pages
        section(7, vec([
            [...str('w_path_open'), 0x00, 5],
            [...str('w_fd_read'), 0x00, 6],
            [...str('w_fd_close'), 0x00, 7],
            [...str('w_fd_fdstat_get'), 0x00, 8],
            [...str('w_path_filestat_get'), 0x00, 9],
            [...str(entry), 0x00, 10],
            [...str('memory'), 0x02, 0],
        ])),
        section(10, vec([
            fwd(9, 0), fwd(4, 1), fwd(1, 2), fwd(2, 3), fwd(5, 4),
            body([], []),                                  // entry: no-op
        ])),
    ];
    return Uint8Array.from([...MAGIC, ...parts.flat()]);
}

/* Rights must be a realistic subset: node validates the requested rights
 * against what the preopen grants, and asking for all-ones fails even a
 * legitimate open, which would mask every real result. */
const RIGHTS = 2n | 64n | 8192n | 0x4000n | 0x20n | 0x8n | 0x40000n | 0x1000000n;

interface Sandbox { root: string; jail: string }
function makeSandbox(): Sandbox {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cno-wasi-fd-'));
    const jail = path.join(root, 'jail');
    fs.mkdirSync(path.join(jail, 'sub'), { recursive: true });
    fs.writeFileSync(path.join(jail, 'file.txt'), 'FILE-CONTENT');
    return { root, jail };
}

function startProbe(sb: Sandbox, opts: Record<string, unknown> = {}): { w: WASI; x: Probe } {
    const w = new WASI({
        version: 'preview1',
        args: ['probe'],
        env: {},
        preopens: { '/jail': sb.jail },
        returnOnExit: true,
        ...opts,
    });
    const inst = new WebAssembly.Instance(new WebAssembly.Module(buildProbe('_start')), w.getImportObject());
    w.start(inst);
    return { w, x: inst.exports as unknown as Probe };
}
const writeStr = (x: Probe, at: number, s: string): number => {
    const b = new TextEncoder().encode(s);
    new Uint8Array(x.memory.buffer).set(b, at);
    return b.length;
};

// ============================================================================
// filetype reporting
// ============================================================================

Deno.test('wasi: path_filestat_get reports directory as 3 and a regular file as 4', () => {
    const sb = makeSandbox();
    const { x } = startProbe(sb);
    const dv = new DataView(x.memory.buffer);

    const dlen = writeStr(x, 0x100, 'sub');
    strictEqual(x.w_path_filestat_get(3, 1, 0x100, dlen, 0x800), 0, 'stat of a dir inside the preopen must succeed');
    strictEqual(dv.getUint8(0x800 + 16), 3, 'WASI filetype for a directory is 3');

    const flen = writeStr(x, 0x100, 'file.txt');
    strictEqual(x.w_path_filestat_get(3, 1, 0x100, flen, 0x840), 0);
    strictEqual(dv.getUint8(0x840 + 16), 4, 'WASI filetype for a regular file is 4');
    strictEqual(Number(dv.getBigUint64(0x840 + 32, true)), 12, 'size must be the real byte count');
});

Deno.test('wasi: fd_fdstat_get reports a preopen dirfd as a directory', () => {
    const sb = makeSandbox();
    const { x } = startProbe(sb);
    strictEqual(x.w_fd_fdstat_get(3, 0x900), 0);
    strictEqual(new DataView(x.memory.buffer).getUint8(0x900), 3, 'a preopen dirfd is filetype 3 (directory)');
});

Deno.test('wasi: fd_fdstat_get reports an opened regular file as filetype 4', () => {
    const sb = makeSandbox();
    const { x } = startProbe(sb);
    const dv = new DataView(x.memory.buffer);
    const len = writeStr(x, 0x100, 'file.txt');
    strictEqual(x.w_path_open(3, 1, 0x100, len, 0, RIGHTS, RIGHTS, 0, 0x200), 0);
    const fd = dv.getUint32(0x200, true);
    ok(fd > 3, 'an opened file gets a guest fd distinct from the preopen dirfd');
    strictEqual(x.w_fd_fdstat_get(fd, 0x900), 0);
    strictEqual(dv.getUint8(0x900), 4, 'an opened regular file is filetype 4');
    x.w_fd_close(fd);
});

// ============================================================================
// fd bookkeeping: an ungranted fd is EBADF, and never reaches the host CRT
// ============================================================================

const WASI_EBADF = 8;

Deno.test('wasi: fd_fdstat_get on an fd that was never granted is EBADF', () => {
    const sb = makeSandbox();
    const { x } = startProbe(sb);
    strictEqual(x.w_fd_fdstat_get(9999, 0x900), WASI_EBADF);
    strictEqual(x.w_fd_fdstat_get(4242, 0x900), WASI_EBADF);
    /* Negative control: a granted fd still works. */
    strictEqual(x.w_fd_fdstat_get(3, 0x900), 0);
});

Deno.test('wasi: fd_close on an fd that was never granted is EBADF', () => {
    const sb = makeSandbox();
    const { x } = startProbe(sb);
    strictEqual(x.w_fd_close(9999), WASI_EBADF);
    strictEqual(x.w_fd_close(31337), WASI_EBADF);
    strictEqual(x.w_fd_close(-1), WASI_EBADF);
});

Deno.test('wasi: fd_read on an fd that was never granted is EBADF', () => {
    const sb = makeSandbox();
    const { x } = startProbe(sb);
    strictEqual(x.w_fd_read(9999, 0, 0, 0), WASI_EBADF);
});

Deno.test('wasi: a real fd closes once, then reports EBADF', () => {
    const sb = makeSandbox();
    const { x } = startProbe(sb);
    const dv = new DataView(x.memory.buffer);
    const len = writeStr(x, 0x100, 'file.txt');
    strictEqual(x.w_path_open(3, 1, 0x100, len, 0, RIGHTS, RIGHTS, 0, 0x200), 0);
    const fd = dv.getUint32(0x200, true);
    strictEqual(x.w_fd_close(fd), 0, 'the first close succeeds');
    strictEqual(x.w_fd_close(fd), WASI_EBADF, 'a second close must be refused, not passed to the host');
});

// ============================================================================
// stdio redirection
// ============================================================================

Deno.test('wasi: fd_read on fd 0 honours options.stdin', () => {
    const sb = makeSandbox();
    const stdinPath = path.join(sb.root, 'stdin.txt');
    fs.writeFileSync(stdinPath, 'HELLO-STDIN');
    const fd = fs.openSync(stdinPath, 'r');
    try {
        const { x } = startProbe(sb, { stdin: fd });
        const dv = new DataView(x.memory.buffer);
        /* iovec at 0x10 -> { buf: 0x400, len: 64 } */
        dv.setUint32(0x10, 0x400, true);
        dv.setUint32(0x14, 64, true);
        dv.setUint32(0x300, 0, true);
        strictEqual(x.w_fd_read(0, 0x10, 1, 0x300), 0, 'fd_read must succeed');
        const n = dv.getUint32(0x300, true);
        strictEqual(n, 11, 'must read the 11 bytes of the redirected stdin, not report a silent EOF');
        const got = new TextDecoder().decode(new Uint8Array(x.memory.buffer, 0x400, n));
        strictEqual(got, 'HELLO-STDIN');
    } finally {
        try { fs.closeSync(fd); } catch { /* already closed */ }
    }
});

Deno.test('wasi: fd_write on fd 1 honours options.stdout', () => {
    const sb = makeSandbox();
    const outPath = path.join(sb.root, 'stdout.txt');
    const fd = fs.openSync(outPath, 'w');
    /* Module that writes "MARK\n" to fd 1 and returns. */
    const msg = [...new TextEncoder().encode('MARK\n')];
    const parts = [
        section(1, vec([ftype([I32, I32, I32, I32], [I32]), ftype([], [])])),
        section(2, vec([[...str(W), ...str('fd_write'), 0x00, 0]])),
        section(3, vec([[1]])),
        section(5, vec([[0x00, 1]])),
        section(7, vec([[...str('_start'), 0x00, 1], [...str('memory'), 0x02, 0]])),
        section(10, vec([body([], [
            0x41, ...sleb(1), 0x41, ...sleb(0x10), 0x41, ...sleb(1), 0x41, ...sleb(0x08),
            0x10, ...uleb(0), 0x1a,
        ])])),
        section(11, vec([
            [0x00, 0x41, ...sleb(0x10), 0x0b, ...uleb(8), 0x20, 0, 0, 0, msg.length, 0, 0, 0],
            [0x00, 0x41, ...sleb(0x20), 0x0b, ...uleb(msg.length), ...msg],
        ])),
    ];
    const mod = Uint8Array.from([...MAGIC, ...parts.flat()]);
    try {
        const w = new WASI({ version: 'preview1', returnOnExit: true, stdout: fd, preopens: { '/jail': sb.jail } });
        const inst = new WebAssembly.Instance(new WebAssembly.Module(mod), w.getImportObject());
        strictEqual(w.start(inst), 0);
    } finally {
        try { fs.closeSync(fd); } catch { /* ignore */ }
    }
    strictEqual(fs.readFileSync(outPath, 'utf8'), 'MARK\n', 'the guest write must land in the redirected file');
});

// ============================================================================
// start() / initialize() state machine
// ============================================================================

function quietModule(entry: string): Uint8Array {
    const parts = [
        section(1, vec([ftype([I32], []), ftype([], [])])),
        section(2, vec([[...str(W), ...str('proc_exit'), 0x00, 0]])),
        section(3, vec([[1]])),
        section(5, vec([[0x00, 1]])),
        section(7, vec([[...str(entry), 0x00, 1], [...str('memory'), 0x02, 0]])),
        section(10, vec([body([], [])])),
    ];
    return Uint8Array.from([...MAGIC, ...parts.flat()]);
}

Deno.test('wasi: start() twice on one instance is refused', () => {
    const w = new WASI({ version: 'preview1', returnOnExit: true });
    const inst = new WebAssembly.Instance(new WebAssembly.Module(quietModule('_start')), w.getImportObject());
    strictEqual(w.start(inst), 0);
    throws(() => w.start(inst), (e: unknown) => (e as { code?: string })?.code === 'ERR_WASI_ALREADY_STARTED');
});

Deno.test('wasi: initialize() then start() is refused', () => {
    const w = new WASI({ version: 'preview1', returnOnExit: true });
    const inst = new WebAssembly.Instance(new WebAssembly.Module(quietModule('_initialize')), w.getImportObject());
    w.initialize(inst);
    throws(() => w.start(inst), (e: unknown) => (e as { code?: string })?.code === 'ERR_WASI_ALREADY_STARTED');
});

Deno.test('wasi: initialize() twice is refused', () => {
    const w = new WASI({ version: 'preview1', returnOnExit: true });
    const inst = new WebAssembly.Instance(new WebAssembly.Module(quietModule('_initialize')), w.getImportObject());
    w.initialize(inst);
    throws(() => w.initialize(inst), (e: unknown) => (e as { code?: string })?.code === 'ERR_WASI_ALREADY_STARTED');
});

Deno.test('wasi: start() on a module with no _start throws instead of reporting exit 1', () => {
    const w = new WASI({ version: 'preview1', returnOnExit: true });
    const inst = new WebAssembly.Instance(new WebAssembly.Module(quietModule('_initialize')), w.getImportObject());
    throws(() => w.start(inst), (e: unknown) => (e as { code?: string })?.code === 'ERR_INVALID_ARG_TYPE');
    throws(() => w.start(inst), (e: unknown) => (e as { code?: string })?.code === 'ERR_INVALID_ARG_TYPE',
        'a validation failure must not consume the WASI instance');
});

Deno.test('wasi: start() requires an exported memory', () => {
    const w = new WASI({ version: 'preview1', returnOnExit: true });
    throws(
        () => w.start({ exports: {} } as unknown as WebAssembly.Instance),
        (e: unknown) => (e as { code?: string })?.code === 'ERR_INVALID_ARG_TYPE',
    );
    throws(
        () => w.start({ exports: {} } as unknown as WebAssembly.Instance),
        (e: unknown) => (e as { code?: string })?.code === 'ERR_INVALID_ARG_TYPE',
        'repeating an invalid call must report the same validation error',
    );
});

Deno.test('wasi: returnOnExit surfaces the guest exit code', () => {
    /* Module that calls proc_exit(7). */
    const parts = [
        section(1, vec([ftype([I32], []), ftype([], [])])),
        section(2, vec([[...str(W), ...str('proc_exit'), 0x00, 0]])),
        section(3, vec([[1]])),
        section(5, vec([[0x00, 1]])),
        section(7, vec([[...str('_start'), 0x00, 1], [...str('memory'), 0x02, 0]])),
        section(10, vec([body([], [0x41, ...sleb(7), 0x10, ...uleb(0)])])),
    ];
    const mod = Uint8Array.from([...MAGIC, ...parts.flat()]);
    const w = new WASI({ version: 'preview1', returnOnExit: true });
    const inst = new WebAssembly.Instance(new WebAssembly.Module(mod), w.getImportObject());
    strictEqual(w.start(inst), 7);
});

Deno.test('wasi: the constructor rejects a missing or unsupported version', () => {
    throws(() => new WASI({} as ConstructorParameters<typeof WASI>[0]), TypeError);
    throws(
        () => new WASI({ version: 'preview9' } as unknown as ConstructorParameters<typeof WASI>[0]),
        (e: unknown) => (e as { code?: string })?.code === 'ERR_INVALID_ARG_VALUE',
    );
    ok(new WASI({ version: 'preview1' }) instanceof WASI);
});
