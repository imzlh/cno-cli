/*
 * WASI preopen confinement against a WINDOWS DRIVE-ABSOLUTE path.
 *
 * The existing wasi-preopen-confinement.test.ts covers `..` traversal, POSIX
 * absolute paths, symlinks and junctions. This file adds the drive-letter form
 * (`d:\...` / `d:/...`), which is absolute on Windows but does NOT begin with
 * `/`, so a POSIX-shaped "is it absolute?" test misses it entirely.
 *
 * The node:wasi TS path refuses it, because isAbsolutePath() in
 * cno/src/node/wasi/mod.ts matches /^[A-Za-z]:[\\/]/ as well as a leading slash.
 *
 * SECURITY NOTE, measured, not asserted here: the OTHER WASI path -- WAMR's own
 * libc-wasi, reached by handing preopens to wasm.setWasiOptions() via
 * import.meta.use('wasm') -- DOES leave the sandbox for exactly these inputs.
 * With a preopen granting only a jail directory, a guest read 27 bytes of a file
 * outside it, and also wrote to, unlinked, and created directories outside it.
 * That resolution happens inside circu.js/deps/wamr/.../libc-wasi/
 * sandboxed-system-primitives/src/posix.c, which is vendored and out of scope to
 * change, so it is reported rather than covered by an expected-pass assertion
 * here. Reproducers: d:\tmp\ag-wasm\repro-escape.mjs (read) and
 * repro-escape-write.mjs (write/unlink/mkdir).
 */
import { strictEqual, ok } from 'node:assert';
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

interface Probe {
    memory: WebAssembly.Memory;
    w_path_open: (dirfd: number, dirflags: number, p: number, plen: number, oflags: number, base: bigint, inh: bigint, fdflags: number, fdOut: number) => number;
    w_fd_read: (fd: number, iovs: number, iovsLen: number, nreadOut: number) => number;
    w_fd_close: (fd: number) => number;
    w_path_filestat_get: (dirfd: number, flags: number, p: number, plen: number, out: number) => number;
}

function buildProbe(): Uint8Array {
    const sigs = [
        ftype([I32, I32, I32, I32, I32, I64, I64, I32, I32], [I32]), // 0 path_open
        ftype([I32, I32, I32, I32], [I32]),                          // 1 fd_read
        ftype([I32], [I32]),                                         // 2 fd_close
        ftype([I32, I32, I32, I32, I32], [I32]),                     // 3 path_filestat_get
        ftype([], []),                                               // 4 _start
    ];
    const imports = [
        [...str(W), ...str('path_open'), 0x00, 0],
        [...str(W), ...str('fd_read'), 0x00, 1],
        [...str(W), ...str('fd_close'), 0x00, 2],
        [...str(W), ...str('path_filestat_get'), 0x00, 3],
    ];
    const fwd = (nparams: number, target: number): number[] => {
        const code: number[] = [];
        for (let i = 0; i < nparams; i++) code.push(0x20, ...uleb(i));
        code.push(0x10, ...uleb(target));
        return body([], code);
    };
    const parts = [
        section(1, vec(sigs)),
        section(2, vec(imports)),
        section(3, vec([[0], [1], [2], [3], [4]])),
        section(5, vec([[0x00, 2]])),
        section(7, vec([
            [...str('w_path_open'), 0x00, 4],
            [...str('w_fd_read'), 0x00, 5],
            [...str('w_fd_close'), 0x00, 6],
            [...str('w_path_filestat_get'), 0x00, 7],
            [...str('_start'), 0x00, 8],
            [...str('memory'), 0x02, 0],
        ])),
        section(10, vec([fwd(9, 0), fwd(4, 1), fwd(1, 2), fwd(5, 3), body([], [])])),
    ];
    return Uint8Array.from([...MAGIC, ...parts.flat()]);
}

const RIGHTS = 2n | 64n | 8192n | 0x4000n | 0x20n | 0x8n | 0x40000n | 0x1000000n;
const WASI_ENOTCAPABLE = 76;
const SECRET = 'SECRET-DRIVE-ABS-CANARY';

interface Sandbox { root: string; jail: string; secretPath: string }
function makeSandbox(): Sandbox {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cno-wasi-drv-'));
    const jail = path.join(root, 'jail');
    fs.mkdirSync(jail, { recursive: true });
    fs.writeFileSync(path.join(jail, 'allowed.txt'), 'INSIDE-OK');
    const secretPath = path.join(root, 'secret.txt');
    fs.writeFileSync(secretPath, SECRET);
    return { root, jail, secretPath };
}

function probe(sb: Sandbox): Probe {
    const w = new WASI({
        version: 'preview1',
        args: ['probe'],
        env: {},
        preopens: { '/jail': sb.jail },
        returnOnExit: true,
    });
    const inst = new WebAssembly.Instance(new WebAssembly.Module(buildProbe()), w.getImportObject());
    w.start(inst);
    return inst.exports as unknown as Probe;
}

/* Open `guestPath` under the preopen dirfd and try to read it.
 * Returns the open errno, plus whatever bytes came back. */
function attempt(x: Probe, guestPath: string): { errno: number; content: string } {
    const bytes = new TextEncoder().encode(guestPath);
    new Uint8Array(x.memory.buffer).set(bytes, 0x100);
    const dv = new DataView(x.memory.buffer);
    dv.setUint32(0x200, 0xffffffff, true);
    const errno = x.w_path_open(3, 1, 0x100, bytes.length, 0, RIGHTS, RIGHTS, 0, 0x200);
    if (errno !== 0) return { errno, content: '' };
    const fd = dv.getUint32(0x200, true);
    dv.setUint32(0x10, 0x400, true);
    dv.setUint32(0x14, 256, true);
    dv.setUint32(0x300, 0, true);
    new Uint8Array(x.memory.buffer).fill(0, 0x400, 0x500);
    const rrc = x.w_fd_read(fd, 0x10, 1, 0x300);
    const n = rrc === 0 ? dv.getUint32(0x300, true) : 0;
    const content = new TextDecoder().decode(new Uint8Array(x.memory.buffer, 0x400, n));
    x.w_fd_close(fd);
    return { errno, content };
}

Deno.test('wasi: a path inside the preopen is reachable (negative control)', () => {
    const sb = makeSandbox();
    const r = attempt(probe(sb), 'allowed.txt');
    strictEqual(r.errno, 0, 'the legitimate open must succeed, or every refusal below is meaningless');
    strictEqual(r.content, 'INSIDE-OK');
});

Deno.test('wasi: a drive-absolute path with forward slashes is refused', () => {
    const sb = makeSandbox();
    const guestPath = sb.secretPath.replace(/\\/g, '/');
    ok(/^[A-Za-z]:\//.test(guestPath), `fixture must be drive-absolute, got ${guestPath}`);
    const r = attempt(probe(sb), guestPath);
    strictEqual(r.errno, WASI_ENOTCAPABLE, `expected ENOTCAPABLE for ${guestPath}`);
    ok(!r.content.includes(SECRET), 'the secret must not cross the sandbox boundary');
});

Deno.test('wasi: a drive-absolute path with backslashes is refused', () => {
    const sb = makeSandbox();
    const guestPath = sb.secretPath.replace(/\//g, '\\');
    ok(/^[A-Za-z]:\\/.test(guestPath), `fixture must be drive-absolute, got ${guestPath}`);
    const r = attempt(probe(sb), guestPath);
    strictEqual(r.errno, WASI_ENOTCAPABLE, `expected ENOTCAPABLE for ${guestPath}`);
    ok(!r.content.includes(SECRET), 'the secret must not cross the sandbox boundary');
});

Deno.test('wasi: a bare drive-relative prefix is refused', () => {
    const sb = makeSandbox();
    /* "c:secret.txt" is drive-RELATIVE on Windows -- it resolves against the
     * per-drive current directory, which is still outside the preopen. */
    const r = attempt(probe(sb), 'c:secret.txt');
    ok(r.errno !== 0, 'a drive-qualified path must not open inside the sandbox');
    ok(!r.content.includes(SECRET));
});

Deno.test('wasi: a UNC path is refused', () => {
    const sb = makeSandbox();
    const r = attempt(probe(sb), '//localhost/c$/windows/win.ini');
    ok(r.errno !== 0, 'a UNC path must be refused');
    strictEqual(r.content, '');
});

Deno.test('wasi: path_filestat_get on a drive-absolute path leaks no metadata', () => {
    const sb = makeSandbox();
    const x = probe(sb);
    const guestPath = sb.secretPath.replace(/\\/g, '/');
    const bytes = new TextEncoder().encode(guestPath);
    new Uint8Array(x.memory.buffer).set(bytes, 0x100);
    new Uint8Array(x.memory.buffer).fill(0, 0x800, 0x840);
    const rc = x.w_path_filestat_get(3, 1, 0x100, bytes.length, 0x800);
    ok(rc !== 0, `expected a refusal, got rc=${rc}`);
    const size = new DataView(x.memory.buffer).getBigUint64(0x800 + 32, true);
    strictEqual(Number(size), 0, 'no size may be reported for a file outside the preopen');
});

Deno.test('wasi: a drive-absolute path cannot be created for writing', () => {
    const sb = makeSandbox();
    const x = probe(sb);
    const target = path.join(sb.root, 'created-outside.txt').replace(/\\/g, '/');
    const bytes = new TextEncoder().encode(target);
    new Uint8Array(x.memory.buffer).set(bytes, 0x100);
    const dv = new DataView(x.memory.buffer);
    dv.setUint32(0x200, 0xffffffff, true);
    /* oflags bit 0 = O_CREAT */
    const rc = x.w_path_open(3, 1, 0x100, bytes.length, 1, RIGHTS, RIGHTS, 0, 0x200);
    strictEqual(rc, WASI_ENOTCAPABLE, 'creating a file outside the preopen must be refused');
    strictEqual(fs.existsSync(path.join(sb.root, 'created-outside.txt')), false, 'nothing may appear on disk');
});
