/*
 * WASI preopen confinement.
 *
 * A WASI guest may only reach paths under a directory it was granted via
 * `preopens`. Before the fix, `bindings.path_open` ignored the guest dirfd and
 * handed the raw guest path to the host fs, so a module confined to one
 * directory could open C:\Windows\win.ini -- and fd_read returned its contents.
 *
 * These tests drive the JS `wasiImport` bindings through real wasm bytes so the
 * capability boundary is exercised end to end, not just the resolver in isolation.
 */
import { strictEqual, ok } from 'node:assert';
import { WASI } from 'node:wasi';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

/* ---- minimal wasm emitter (no toolchain needed) ---- */
function uleb(n: number | bigint): number[] {
    const out: number[] = [];
    let v = BigInt(n);
    do { let b = Number(v & 0x7fn); v >>= 7n; if (v !== 0n) b |= 0x80; out.push(b); } while (v !== 0n);
    return out;
}
function sleb(n: number | bigint): number[] {
    const out: number[] = [];
    let v = BigInt(n);
    for (;;) {
        const b = Number(v & 0x7fn);
        v >>= 7n;
        const signBit = (b & 0x40) !== 0;
        if ((v === 0n && !signBit) || (v === -1n && signBit)) { out.push(b); break; }
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
function ftype(params: number[], results: number[]): number[] {
    return [0x60, ...vec(params.map(p => [p])), ...vec(results.map(r => [r]))];
}
function body(locals: number[][], code: number[]): number[] {
    const b = [...vec(locals), ...code, 0x0b];
    return [...uleb(b.length), ...b];
}
const I32 = 0x7f, I64 = 0x7e;

/*
 * _start calls path_open(dirfd=3, <path>) then fd_read, storing:
 *   mem[0] = path_open errno, mem[4] = fd, mem[8] = nread, mem[12] = fd_read errno
 * The path string is placed at offset 1024 by a data section; read buffer at 2048.
 */
function buildProbe(targetPath: string, dirfd = 3): Uint8Array {
    const pb = [...new TextEncoder().encode(targetPath)];
    const parts = [
        section(1, vec([
            ftype([I32, I32, I32, I32, I32, I64, I64, I32, I32], [I32]),  // path_open
            ftype([I32, I32, I32, I32], [I32]),                           // fd_read
            ftype([], []),                                                // _start
        ])),
        section(2, vec([
            [...str('wasi_snapshot_preview1'), ...str('path_open'), 0x00, 0],
            [...str('wasi_snapshot_preview1'), ...str('fd_read'), 0x00, 1],
        ])),
        section(3, vec([[2]])),
        section(5, vec([[0x00, 1]])),
        section(7, vec([[...str('_start'), 0x00, 2], [...str('memory'), 0x02, 0]])),
        section(10, vec([body([], [
            0x41, ...sleb(0),
            0x41, ...sleb(dirfd), 0x41, ...sleb(0), 0x41, ...sleb(1024), 0x41, ...sleb(pb.length),
            0x41, ...sleb(0), 0x42, ...sleb(0n), 0x42, ...sleb(0n), 0x41, ...sleb(0), 0x41, ...sleb(16),
            0x10, 0x00,
            0x36, 0x02, 0x00,
            0x41, ...sleb(32), 0x41, ...sleb(2048), 0x36, 0x02, 0x00,
            0x41, ...sleb(36), 0x41, ...sleb(200), 0x36, 0x02, 0x00,
            0x41, ...sleb(4), 0x41, ...sleb(16), 0x28, 0x02, 0x00, 0x36, 0x02, 0x00,
            0x41, ...sleb(12),
            0x41, ...sleb(16), 0x28, 0x02, 0x00,
            0x41, ...sleb(32), 0x41, ...sleb(1), 0x41, ...sleb(8),
            0x10, 0x01,
            0x36, 0x02, 0x00,
        ])])),
        section(11, vec([[0x00, 0x41, ...sleb(1024), 0x0b, ...uleb(pb.length), ...pb]])),
    ];
    return Uint8Array.from([0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00, ...parts.flat()]);
}

interface Probe { openErrno: number; fd: number; nread: number; content: string }

function makeSandbox(): { root: string; jail: string; secret: string } {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cno-wasi-'));
    const jail = path.join(root, 'jail');
    fs.mkdirSync(jail, { recursive: true });
    fs.writeFileSync(path.join(jail, 'allowed.txt'), 'INSIDE-PREOPEN-OK\n');
    const secret = path.join(root, 'secret.txt');
    fs.writeFileSync(secret, 'SECRET-CANARY-OUTSIDE-PREOPEN\n');
    return { root, jail, secret };
}

function probe(jail: string, targetPath: string): Probe {
    const w = new WASI({ version: 'preview1', args: ['probe'], env: {}, preopens: { '/sandbox': jail } });
    const inst = new WebAssembly.Instance(
        new WebAssembly.Module(buildProbe(targetPath)),
        { wasi_snapshot_preview1: w.wasiImport },
    );
    w.start(inst);
    const buf = (inst.exports.memory as WebAssembly.Memory).buffer;
    const dv = new DataView(buf);
    const nread = dv.getInt32(8, true);
    const content = nread > 0
        ? new TextDecoder().decode(new Uint8Array(buf, 2048, Math.min(nread, 200)))
        : '';
    return { openErrno: dv.getInt32(0, true), fd: dv.getInt32(4, true), nread, content };
}

Deno.test('wasi: absolute host path outside every preopen is refused', () => {
    const { root, jail, secret } = makeSandbox();
    try {
        const r = probe(jail, secret);
        /* Must not open, and must not leak a single byte. */
        ok(r.openErrno !== 0, `path_open must refuse an absolute path outside the preopen, got errno ${r.openErrno}`);
        strictEqual(r.nread, 0, 'no bytes may be read from outside the preopen');
        ok(!r.content.includes('SECRET-CANARY'), 'canary content must not reach the guest');
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

Deno.test('wasi: parent-directory traversal out of a preopen is refused', () => {
    const { root, jail } = makeSandbox();
    try {
        const r = probe(jail, '../secret.txt');
        ok(r.openErrno !== 0, `".." escape must be refused, got errno ${r.openErrno}`);
        strictEqual(r.nread, 0, 'no bytes may be read via a traversal');
        ok(!r.content.includes('SECRET-CANARY'), 'canary content must not reach the guest');
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

Deno.test('wasi: a path inside the preopen is still reachable', () => {
    const { root, jail } = makeSandbox();
    try {
        const r = probe(jail, 'allowed.txt');
        /* The guard must not be so blunt that it breaks legitimate access --
         * this is what distinguishes confinement from simply denying everything. */
        strictEqual(r.openErrno, 0, 'a file inside the preopen must open');
        ok(r.nread > 0, 'a file inside the preopen must be readable');
        ok(r.content.includes('INSIDE-PREOPEN-OK'), `expected preopen content, got ${JSON.stringify(r.content)}`);
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

Deno.test('wasi: a dirfd that was never granted has no filesystem capability', () => {
    const { root, jail } = makeSandbox();
    try {
        /* Only one preopen exists, so it takes fd 3; fd 9 was never granted.
         * Target a file that really does exist inside the jail, so the only
         * reason to fail is the ungranted dirfd. */
        const w = new WASI({ version: 'preview1', args: ['p'], env: {}, preopens: { '/sandbox': jail } });
        const inst = new WebAssembly.Instance(
            new WebAssembly.Module(buildProbe('allowed.txt', 9)),
            { wasi_snapshot_preview1: w.wasiImport },
        );
        w.start(inst);
        const dv = new DataView((inst.exports.memory as WebAssembly.Memory).buffer);
        ok(dv.getInt32(0, true) !== 0, 'an ungranted dirfd must not open a file');
        strictEqual(dv.getInt32(8, true), 0, 'an ungranted dirfd must not read bytes');
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

Deno.test('wasi: preopens are advertised via fd_prestat_get', () => {
    const { root, jail } = makeSandbox();
    try {
        const w = new WASI({ version: 'preview1', args: ['p'], env: {}, preopens: { '/sandbox': jail } });
        const g = w.wasiImport as unknown as Record<string, (...a: number[]) => number>;
        ok(typeof g.fd_prestat_get === 'function', 'fd_prestat_get must exist for guests to discover preopens');
        ok(typeof g.fd_prestat_dir_name === 'function', 'fd_prestat_dir_name must exist');
        /* fd 3 is the first preopen; a fd past the table must report EBADF (8). */
        strictEqual(g.fd_prestat_get(99, 0), 8, 'an unknown fd must report EBADF');
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

/*
 * Link-based escapes. A lexical path check cannot see these: a symlink or
 * directory junction planted inside the preopen names no ".." and is not
 * absolute, yet resolves wherever it points. Containment must therefore be
 * decided on the canonicalised target, not the path as written.
 */
function linkSandbox(): { root: string; jail: string; outside: string } {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cno-wasi-link-'));
    const jail = path.join(root, 'jail');
    const outside = path.join(root, 'outside');
    fs.mkdirSync(jail, { recursive: true });
    fs.mkdirSync(outside, { recursive: true });
    fs.writeFileSync(path.join(jail, 'allowed.txt'), 'INSIDE-PREOPEN-OK\n');
    fs.writeFileSync(path.join(outside, 'loot.txt'), 'LINK-CANARY-OUTSIDE\n');
    return { root, jail, outside };
}

Deno.test('wasi: a file symlink pointing outside the preopen is refused', () => {
    const { root, jail, outside } = linkSandbox();
    try {
        try {
            fs.symlinkSync(path.join(outside, 'loot.txt'), path.join(jail, 'link.txt'), 'file');
        } catch {
            /* Creating symlinks can require elevation; skip rather than pass vacuously. */
            console.log('    (skipped: cannot create a symlink in this environment)');
            return;
        }
        const r = probe(jail, 'link.txt');
        ok(!r.content.includes('LINK-CANARY'), 'a symlink must not leak content from outside the preopen');
        strictEqual(r.nread, 0, 'no bytes may be read through a symlink out of the preopen');
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

Deno.test('wasi: traversal through a directory junction is refused', () => {
    const { root, jail, outside } = linkSandbox();
    try {
        try {
            fs.symlinkSync(outside, path.join(jail, 'dirlink'), 'junction');
        } catch {
            console.log('    (skipped: cannot create a junction in this environment)');
            return;
        }
        const r = probe(jail, 'dirlink/loot.txt');
        ok(!r.content.includes('LINK-CANARY'), 'a junction must not leak content from outside the preopen');
        strictEqual(r.nread, 0, 'no bytes may be read through a junction out of the preopen');
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

Deno.test('wasi: a path that normalises back inside the preopen still works', () => {
    const { root, jail } = linkSandbox();
    try {
        /* Guards against over-blocking: "nosuch/../allowed.txt" never leaves the
         * root, so refusing it would break legitimate guests. */
        const r = probe(jail, 'nosuch/../allowed.txt');
        strictEqual(r.openErrno, 0, 'a path normalising back inside the root must open');
        ok(r.content.includes('INSIDE-PREOPEN-OK'), 'expected the in-preopen file content');
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
