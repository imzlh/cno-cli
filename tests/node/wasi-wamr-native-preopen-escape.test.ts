/*
 * ===========================================================================
 * Regression coverage for the WAMR-native preopen boundary.
 *
 * These tests PASS on a fixed runtime and go RED if the fix is reverted. They
 * are no longer `ignore`d: the drive-letter vector was fixed on 2026-08-10 (see
 * LAYER / STATUS below), so the file now serves as the tripwire for a revert
 * rather than documentation of an open hole.
 * ===========================================================================
 *
 * VECTOR
 *   A WASI guest is granted exactly one directory via `preopens`. It then names
 *   a file outside that directory using a WINDOWS DRIVE-ABSOLUTE path --
 *   `d:/some/where/secret.txt` or `d:\some\where\secret.txt`.
 *
 *   Such a path is absolute on Windows but does NOT begin with `/`. WAMR's
 *   libc-wasi tests absolute-ness the POSIX way, so `d:/...` is treated as a
 *   RELATIVE path whose first component is `d:`; the host open then resolves the
 *   drive letter and the guest lands outside its sandbox.
 *
 * REACHED VIA
 *   `import.meta.use('wasm')`, available to any script, exposes `setWasiOptions`
 *   directly. Handing it real preopens configures WAMR's own libc-wasi, which
 *   then serves every `path_*` syscall without cno's containment check running.
 *   This is a different code path from `node:wasi`, whose TS bindings DO refuse
 *   all of these vectors (see wasi-preopen-escape-drive-absolute.test.ts).
 *
 * MEASURED 2026-08-10 on build/stage/cno.exe (Debug, 12:58 — WITH the fix)
 *   preopen: { '/jail': <sandbox>/jail }   target: <sandbox>/secret.txt (OUTSIDE)
 *     baseline 'allowed.txt'                    -> READ 15B "INSIDE-THE-JAIL"
 *     'd:/.../creds.txt'                        -> errno 76 ENOTCAPABLE
 *     'd:\...\creds.txt'                        -> errno 76 ENOTCAPABLE
 *     path_open(victim, O_CREAT|O_TRUNC)        -> errno 76, victim unmodified
 *     path_unlink_file(victim)                  -> rc 76, file still present
 *     path_create_directory(outside/...)        -> rc 76, nothing created
 *     '../secret.txt' and '/'-absolute          -> errno 76 (control)
 *
 * MEASURED EARLIER on build/stage/cno.exe (Aug 9 22:06 — BEFORE the fix)
 *     baseline 'allowed.txt'                    -> READ 15B "INSIDE-THE-JAIL"
 *     'd:/.../repro-secrets/creds.txt'          -> READ 27B "AKIA-REPRO-0001-DO-NOT-LEAK"
 *     'd:\...\repro-secrets\creds.txt'          -> READ 27B, same bytes
 *     path_open(victim, O_CREAT|O_TRUNC)+write  -> rc=0, 14 bytes written
 *     path_unlink_file(victim)                  -> rc=0, FILE DELETED
 *     path_create_directory(outside/...)        -> rc=0, DIR CREATED
 *     '../secret.txt' and '/'-absolute          -> errno 76 ENOTCAPABLE (control)
 *   The `..` control refusing in BOTH runs is what makes the diagnosis specific:
 *   the sandbox worked in general; only the drive-letter form bypassed it.
 *
 * LAYER / STATUS
 *   Resolution lives in circu.js/deps/wamr/core/iwasm/libraries/libc-wasi/
 *   sandboxed-system-primitives/src/posix.c.
 *
 *   FIXED 2026-08-10 in `path_get()`: a BH_PLATFORM_WINDOWS-guarded check rejects
 *   any path whose first component is a drive letter followed by ':' with
 *   __WASI_ENOTCAPABLE. Because path_get() is the shared chokepoint, this covers
 *   path_open, path_unlink_file and path_create_directory alike -- all three are
 *   now refused, re-measured below. The check also catches the drive-RELATIVE
 *   form (`C:secret`), not just `C:\secret`.
 *
 *   TWO CAVEATS, both measured, that keep this file valuable rather than vestigial:
 *
 *   1. The fix is an UNCOMMITTED edit inside a vendored submodule
 *      (`circu.js/deps/wamr` shows dirty). A submodule update, reset, or fresh
 *      clone silently reverts it and the escape returns with no source change
 *      visible in cno itself. These tests are the tripwire for exactly that.
 *   2. As of 2026-08-10 the shipped RELEASE binary
 *      (build-release/stage/cno.exe, Aug 4) predates the fix and STILL ESCAPES:
 *      measured READ 27B "AKIA-REPRO-0001-DO-NOT-LEAK" from outside the preopen.
 *      A Release rebuild is required before the fix can be called shipped.
 *
 *   Still open, unrelated to the drive-letter vector: a real symlink inside a
 *   preopen aborts the process at posix.c:1527 (`bh_strcat_s` on a too-small
 *   buffer; the line moved from 1519 by the 8 inserted lines). Debug aborts at
 *   exit 3; Release compiles the assertion out and continues. The abort truncates
 *   the run before the directory-symlink case, so that vector remains unobserved.
 *
 * SHAPE OF THE ASSERTION
 *   Every check below asserts THE READ/WRITE MUST FAIL, so the file stays correct
 *   whether the fix is present (green) or reverted (red) -- no edits either way.
 */
import { strictEqual, ok } from 'node:assert';
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

/* Probe module: re-exports path_open / fd_read / fd_close / path_unlink_file /
 * path_create_directory so the host drives each syscall directly. */
function buildProbe(): Uint8Array {
    const sigs = [
        ftype([I32, I32, I32, I32, I32, I64, I64, I32, I32], [I32]), // 0 path_open
        ftype([I32, I32, I32, I32], [I32]),                          // 1 fd_read
        ftype([I32], [I32]),                                         // 2 fd_close
        ftype([I32, I32, I32], [I32]),                               // 3 path_unlink_file
        ftype([I32], []),                                            // 4 proc_exit
        ftype([], []),                                               // 5 _start
    ];
    const imports = [
        [...str(W), ...str('path_open'), 0x00, 0],
        [...str(W), ...str('fd_read'), 0x00, 1],
        [...str(W), ...str('fd_close'), 0x00, 2],
        [...str(W), ...str('path_unlink_file'), 0x00, 3],
        [...str(W), ...str('path_create_directory'), 0x00, 3],
        [...str(W), ...str('proc_exit'), 0x00, 4],
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
        section(3, vec([[0], [1], [2], [3], [3], [5]])),
        section(5, vec([[0x00, 2]])),
        section(7, vec([
            [...str('w_path_open'), 0x00, 6],
            [...str('w_fd_read'), 0x00, 7],
            [...str('w_fd_close'), 0x00, 8],
            [...str('w_path_unlink_file'), 0x00, 9],
            [...str('w_path_create_directory'), 0x00, 10],
            [...str('_start'), 0x00, 11],
            [...str('memory'), 0x02, 0],
        ])),
        section(10, vec([
            fwd(9, 0), fwd(4, 1), fwd(1, 2), fwd(3, 3), fwd(3, 4), body([], []),
        ])),
    ];
    return Uint8Array.from([...MAGIC, ...parts.flat()]);
}

const RIGHTS = 2n | 64n | 8192n | 0x4000n | 0x20n | 0x8n | 0x40000n | 0x1000000n
    | 0x10n | 0x800n | 0x400000n;
const SECRET = 'WAMR-NATIVE-ESCAPE-CANARY';

interface Ctx {
    root: string;
    jail: string;
    secretPath: string;
    mem: ArrayBuffer;
    call: (name: string, ...args: unknown[]) => number;
}

/*
 * Build the guest on the WAMR-NATIVE path: preopens go straight to
 * wasm_runtime_set_wasi_args via setWasiOptions, and no JS WASI bindings are
 * supplied, so WAMR's libc-wasi serves every syscall.
 */
/*
 * Sandboxes created by this file, removed by the last test. These tests are
 * `ignore: true`, so this only matters once someone un-ignores them -- at which
 * point a litter of temp dirs in the repo root would be its own nuisance.
 */
const createdRoots: string[] = [];
function cleanupRoots(): void {
    for (const r of createdRoots.splice(0)) {
        try { fs.rmSync(r, { recursive: true, force: true }); } catch { /* best effort */ }
    }
}

function nativeGuest(): Ctx {
    /*
     * The sandbox must live on the SAME DRIVE as the process cwd.
     *
     * WAMR treats a drive-qualified host path as relative (that is the whole
     * defect), so a preopen under os.tmpdir() on C: while the cwd is on D: is
     * resolved as D:\...\C:\Users\... and does not exist -- the legitimate open
     * then returns errno 28 EINVAL and every escape check below fails for a
     * setup reason that is indistinguishable from "the sandbox held". Measured:
     * host preopens on the cwd's drive are USABLE (rc=0) in both slash forms;
     * on another drive both are UNUSABLE (rc=28).
     *
     * It also means the escape is drive-scoped: it reaches anything on the
     * current drive.
     */
    const base = fs.mkdtempSync(path.join(process.cwd(), 'cno-wamr-esc-'));
    createdRoots.push(base);
    const root = base.replace(/\\/g, '/');
    const jail = root + '/jail';
    fs.mkdirSync(jail, { recursive: true });
    fs.writeFileSync(jail + '/allowed.txt', 'INSIDE-THE-JAIL');
    const secretPath = root + '/secret.txt';
    fs.writeFileSync(secretPath, SECRET);

    const wasm = (import.meta as unknown as { use: (m: string) => Record<string, Function> }).use('wasm');
    const bytes = buildProbe();
    const mod = wasm.parseModule(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
    wasm.setWasiOptions(mod, ['probe'], null, { '/jail': jail });
    const inst = wasm.buildInstance(mod);
    const mem = wasm.getMemoryBuffer(inst) as ArrayBuffer;
    const call = (name: string, ...args: unknown[]): number =>
        wasm.callFuncByIndex(inst, wasm.getFuncIndex(inst, name), ...args) as number;
    call('_start');
    return { root, jail, secretPath, mem, call };
}

function writePath(c: Ctx, at: number, s: string): number {
    const b = new TextEncoder().encode(s);
    new Uint8Array(c.mem).set(b, at);
    return b.length;
}

/* Open `guestPath` and read it. Returns the open errno and any bytes obtained. */
function openRead(c: Ctx, guestPath: string): { errno: number; content: string } {
    const len = writePath(c, 0x100, guestPath);
    const dv = new DataView(c.mem);
    dv.setUint32(0x200, 0xffffffff, true);
    const errno = c.call('w_path_open', 3, 1, 0x100, len, 0, RIGHTS, RIGHTS, 0, 0x200);
    if (errno !== 0) return { errno, content: '' };
    const fd = dv.getUint32(0x200, true);
    dv.setUint32(0x10, 0x400, true);
    dv.setUint32(0x14, 256, true);
    dv.setUint32(0x300, 0, true);
    new Uint8Array(c.mem).fill(0, 0x400, 0x500);
    const rrc = c.call('w_fd_read', fd, 0x10, 1, 0x300);
    const n = rrc === 0 ? dv.getUint32(0x300, true) : 0;
    const content = new TextDecoder().decode(new Uint8Array(c.mem, 0x400, n));
    c.call('w_fd_close', fd);
    return { errno, content };
}

const WASI_ENOTCAPABLE = 76;

Deno.test({
    name: 'wasi/WAMR-native: baseline inside the preopen is readable (control)',
    fn: () => {
        const c = nativeGuest();
        const r = openRead(c, 'allowed.txt');
        strictEqual(r.errno, 0, 'the legitimate open must succeed or the escape checks prove nothing');
        strictEqual(r.content, 'INSIDE-THE-JAIL');
    },
});

Deno.test({
    name: 'wasi/WAMR-native: parent traversal is refused (control that isolates the vector)',
    fn: () => {
        const c = nativeGuest();
        const r = openRead(c, '../secret.txt');
        strictEqual(r.errno, WASI_ENOTCAPABLE, 'dotdot must be refused; it already is');
        ok(!r.content.includes(SECRET));
    },
});

Deno.test({
    name: 'wasi/WAMR-native: a drive-absolute path must NOT read outside the preopen',
    fn: () => {
        const c = nativeGuest();
        const guestPath = c.secretPath.replace(/\\/g, '/');
        ok(/^[A-Za-z]:\//.test(guestPath), `fixture must be drive-absolute, got ${guestPath}`);
        const r = openRead(c, guestPath);
        ok(
            !r.content.includes(SECRET),
            `SANDBOX ESCAPE: read ${r.content.length} bytes from outside the preopen via ${guestPath}`,
        );
        strictEqual(r.errno, WASI_ENOTCAPABLE, 'a path outside every preopen must be ENOTCAPABLE');
    },
});

Deno.test({
    name: 'wasi/WAMR-native: a drive-absolute path with backslashes must NOT read outside',
    fn: () => {
        const c = nativeGuest();
        const guestPath = c.secretPath.replace(/\//g, '\\');
        const r = openRead(c, guestPath);
        ok(
            !r.content.includes(SECRET),
            `SANDBOX ESCAPE: read ${r.content.length} bytes from outside the preopen via ${guestPath}`,
        );
        strictEqual(r.errno, WASI_ENOTCAPABLE);
    },
});

Deno.test({
    name: 'wasi/WAMR-native: a drive-absolute path must NOT create a file outside the preopen',
    fn: () => {
        const c = nativeGuest();
        const target = c.root + '/created-by-guest.txt';
        const len = writePath(c, 0x100, target.replace(/\\/g, '/'));
        const dv = new DataView(c.mem);
        dv.setUint32(0x200, 0xffffffff, true);
        /* oflags bit 0 = O_CREAT, bit 3 = O_TRUNC */
        const rc = c.call('w_path_open', 3, 1, 0x100, len, 1 | 8, RIGHTS, RIGHTS, 0, 0x200);
        strictEqual(rc, WASI_ENOTCAPABLE, 'creating a file outside the preopen must be refused');
        strictEqual(fs.existsSync(target), false, `SANDBOX ESCAPE: guest created ${target}`);
    },
});

Deno.test({
    name: 'wasi/WAMR-native: a drive-absolute path must NOT truncate a file outside the preopen',
    fn: () => {
        const c = nativeGuest();
        const victim = c.root + '/victim.txt';
        fs.writeFileSync(victim, 'ORIGINAL-CONTENT-UNTOUCHED');
        const len = writePath(c, 0x100, victim.replace(/\\/g, '/'));
        const dv = new DataView(c.mem);
        dv.setUint32(0x200, 0xffffffff, true);
        c.call('w_path_open', 3, 1, 0x100, len, 1 | 8, RIGHTS, RIGHTS, 0, 0x200);
        strictEqual(
            fs.readFileSync(victim, 'utf8'),
            'ORIGINAL-CONTENT-UNTOUCHED',
            'SANDBOX ESCAPE: a file outside the preopen was modified or truncated',
        );
    },
});

Deno.test({
    name: 'wasi/WAMR-native: a drive-absolute path must NOT unlink a file outside the preopen',
    fn: () => {
        const c = nativeGuest();
        const victim = c.root + '/to-delete.txt';
        fs.writeFileSync(victim, 'DO-NOT-DELETE-ME');
        const len = writePath(c, 0x100, victim.replace(/\\/g, '/'));
        const rc = c.call('w_path_unlink_file', 3, 0x100, len);
        ok(rc !== 0, 'unlink outside the preopen must be refused');
        strictEqual(fs.existsSync(victim), true, 'SANDBOX ESCAPE: guest deleted a file outside the preopen');
    },
});

Deno.test({
    name: 'wasi/WAMR-native: a drive-absolute path must NOT create a directory outside the preopen',
    fn: () => {
        const c = nativeGuest();
        const target = c.root + '/dir-by-guest';
        const len = writePath(c, 0x100, target.replace(/\\/g, '/'));
        const rc = c.call('w_path_create_directory', 3, 0x100, len);
        ok(rc !== 0, 'mkdir outside the preopen must be refused');
        strictEqual(fs.existsSync(target), false, `SANDBOX ESCAPE: guest created directory ${target}`);
    },
});

Deno.test({
    name: 'wasi/WAMR-native: cleanup (removes the sandboxes this file created)',
    fn: () => {
        cleanupRoots();
        ok(true);
    },
});
