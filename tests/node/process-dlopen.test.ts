/**
 * process.dlopen — same Node-API loader as CJS require('*.node').
 * Success path: repo-local N-API fixture (built from addon.c if needed).
 */
import { strictEqual, ok, throws } from 'node:assert';
import { existsSync, mkdtempSync, openSync, readSync, closeSync, rmSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import process from 'node:process';
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';

const require = createRequire(import.meta.url);

const FIXTURE_DIR = fileURLToPath(new URL('./fixtures/napi-addon/', import.meta.url));
/**
 * A .node is a platform-native shared library, so the artifact is tagged with
 * platform+arch. An untagged name let a Linux-built ELF sit in the tree and be
 * handed to a Windows cno.exe, which reported "is not a valid Win32
 * application" — a stale-artifact bug that looked like a missing dlopen.
 */
const FIXTURE_NODE = join(
    FIXTURE_DIR,
    `cno_napi_fixture-${process.platform}-${process.arch}.node`,
);

/** Magic bytes the host loader will accept, per platform. */
function hasNativeObjectFormat(file: string): boolean {
    let fd: number;
    try {
        fd = openSync(file, 'r');
    } catch {
        return false;
    }
    try {
        const head = Buffer.alloc(4);
        if (readSync(fd, head, 0, 4, 0) < 4) return false;
        if (process.platform === 'win32') return head[0] === 0x4d && head[1] === 0x5a; // "MZ"
        if (process.platform === 'darwin') {
            const be = head.readUInt32BE(0);
            // Mach-O 32/64 (either endianness) or a universal binary.
            return be === 0xfeedface || be === 0xfeedfacf ||
                be === 0xcefaedfe || be === 0xcffaedfe ||
                be === 0xcafebabe || be === 0xbebafeca;
        }
        return head[0] === 0x7f && head[1] === 0x45 && head[2] === 0x4c && head[3] === 0x46; // ELF
    } finally {
        closeSync(fd);
    }
}

/** Locate an MSVC install: an active developer shell first, then vswhere. */
function findMsvcRoot(): string | null {
    const fromEnv = process.env.VSINSTALLDIR;
    if (fromEnv && existsSync(join(fromEnv, 'VC/Auxiliary/Build'))) return fromEnv;
    const vswhere = join(
        process.env['ProgramFiles(x86)'] ?? 'C:/Program Files (x86)',
        'Microsoft Visual Studio/Installer/vswhere.exe',
    );
    if (!existsSync(vswhere)) return null;
    const r = spawnSync(vswhere, [
        '-latest', '-products', '*',
        '-requires', 'Microsoft.VisualStudio.Component.VC.Tools.x86.x64',
        '-property', 'installationPath',
    ], { encoding: 'utf8' });
    const root = r.status === 0 ? (r.stdout ?? '').trim().split(/\r?\n/)[0] : '';
    return root && existsSync(root) ? root : null;
}

/**
 * Build the fixture with MSVC.
 *
 * PE/COFF cannot leave imports undefined the way `--allow-shlib-undefined`
 * does on ELF, so the napi_* calls are bound through an import library
 * generated from cno.def against the host executable's own export table —
 * the node.lib trick, minus the shipped .lib. Returns null on success,
 * otherwise a human-readable reason.
 */
function buildFixtureMsvc(): string | null {
    const vsRoot = findMsvcRoot();
    if (!vsRoot) return 'no MSVC installation found (VSINSTALLDIR unset, vswhere found nothing)';

    // MSVC spells the same target differently in each place: the batch file is
    // vcvars64/vcvarsarm64, while /machine wants x64/arm64.
    const machine = process.arch === 'arm64' ? 'arm64' : 'x64';
    const vcvars = join(vsRoot, `VC/Auxiliary/Build/vcvars${machine === 'arm64' ? 'arm64' : '64'}.bat`);
    if (!existsSync(vcvars)) return `missing ${vcvars}`;

    // FIXTURE_DIR is <repo>/tests/node/fixtures/napi-addon/ — four levels down.
    const inc = join(FIXTURE_DIR, '../../../../circu.js/deps/nodeapi');
    const work = mkdtempSync(join(tmpdir(), 'cno-napi-fixture-'));
    // vcvars only mutates its own cmd environment, so the whole toolchain
    // invocation has to live inside one batch file.
    const bat = join(work, 'build.bat');
    writeFileSync(bat, [
        '@echo off',
        `call "${vcvars}" >nul 2>&1 || exit /b 90`,
        `cd /d "${work}" || exit /b 91`,
        `lib /nologo "/def:${join(FIXTURE_DIR, 'cno.def')}" /out:cno.lib /machine:${machine} || exit /b 92`,
        // /IMPLIB keeps cl's .lib/.exp byproducts out of the repo; only the
        // .node itself (gitignored) is written into the fixture directory.
        `cl /nologo /LD /O2 "/I${inc}" "${join(FIXTURE_DIR, 'addon.c')}" "/Fe:${FIXTURE_NODE}" /link cno.lib "/IMPLIB:${join(work, 'fixture.lib')}" || exit /b 93`,
        'exit /b 0',
    ].join('\r\n') + '\r\n');

    try {
        const r = spawnSync('cmd.exe', ['/d', '/c', bat], { encoding: 'utf8' });
        if (r.status === 0) return null;
        const stage = { 90: 'vcvars', 91: 'chdir', 92: 'lib', 93: 'cl' }[r.status ?? -1] ?? 'spawn';
        return [`MSVC build failed at ${stage} (status ${r.status})`, r.stdout, r.stderr, r.error?.message]
            .filter(Boolean).join('\n');
    } finally {
        rmSync(work, { recursive: true, force: true });
    }
}

/** Build the fixture with make + a POSIX C compiler. */
function buildFixturePosix(): string | null {
    const r = spawnSync('make', ['-C', FIXTURE_DIR, `OUT=${FIXTURE_NODE}`], { encoding: 'utf8' });
    if (r.status === 0) return null;
    return [`make failed (status ${r.status})`, r.stdout, r.stderr, r.error?.message]
        .filter(Boolean).join('\n');
}

/**
 * Build fixture when absent — source of truth is addon.c (+ Makefile/cno.def).
 * Returns the path, or null when no C toolchain is available to build it.
 */
function ensureNapiFixture(): string | null {
    if (existsSync(FIXTURE_NODE) && hasNativeObjectFormat(FIXTURE_NODE)) return FIXTURE_NODE;

    const reason = process.platform === 'win32' ? buildFixtureMsvc() : buildFixturePosix();
    if (reason !== null) {
        // No toolchain is an environment limitation, not a runtime defect; a
        // toolchain that exists and fails is a real error worth surfacing.
        if (/no MSVC installation found|ENOENT|not found/i.test(reason)) {
            console.log(`skip: cannot build N-API fixture: ${reason}`);
            return null;
        }
        throw new Error(`failed to build N-API fixture in ${FIXTURE_DIR}:\n${reason}`);
    }
    ok(existsSync(FIXTURE_NODE), `build succeeded but ${FIXTURE_NODE} missing`);
    ok(
        hasNativeObjectFormat(FIXTURE_NODE),
        `${FIXTURE_NODE} is not a native object for ${process.platform}`,
    );
    return FIXTURE_NODE;
}


function packageDir(spec: string): string | null {
    try {
        const pkg = require.resolve(`${spec}/package.json`);
        return pkg.slice(0, pkg.lastIndexOf('/'));
    } catch {
        return null;
    }
}

Deno.test('process.dlopen: rejects bad module/filename args', () => {
    throws(() => process.dlopen(null as unknown as object, 'x.node'), TypeError);
    throws(() => process.dlopen({}, ''), TypeError);
    throws(() => process.dlopen({}, 1 as unknown as string), TypeError);
});

Deno.test('process.dlopen: missing file fails closed', () => {
    const mod: { exports?: unknown } = { exports: {} };
    try {
        process.dlopen(mod, '/tmp/grok-goal-90f99bded2f5/implementer/definitely-missing-addon.node');
        ok(false, 'expected throw');
    } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        ok(/Error loading shared library|ERR_DLOPEN|not found|No such file|failed|cannot load/i.test(msg), msg);
        ok(mod.exports === undefined || typeof mod.exports === 'object');
    }
});

Deno.test('process.dlopen: loads Node-API fixture into module.exports', () => {
    const addon = ensureNapiFixture();
    if (!addon) return; // no C toolchain; ensureNapiFixture() logged the reason

    const mod: { exports?: unknown } = { exports: {} };
    process.dlopen(mod, addon);

    ok(mod.exports !== null && typeof mod.exports === 'object', 'exports object set');
    const exp = mod.exports as { tag?: unknown; hello?: unknown };
    strictEqual(exp.tag, 'cno-napi-fixture');
    ok(typeof exp.hello === 'function', 'hello export is a function');
    strictEqual((exp.hello as () => string)(), 'from-napi');
});

Deno.test({
    name: 'process.dlopen: legacy better-sqlite3 fails closed like require',
    timeout: 15000,
}, () => {
    const root = packageDir('better-sqlite3');
    if (!root) {
        console.log('skip: better-sqlite3 not installed (optional fail-closed probe)');
        return;
    }
    const addon = `${root}/build/Release/better_sqlite3.node`;
    if (!existsSync(addon)) {
        console.log('skip: better_sqlite3.node not built (optional fail-closed probe)');
        return;
    }
    const mod: { exports?: unknown } = { exports: {} };
    try {
        process.dlopen(mod, addon);
        ok(false, 'legacy addon must not load');
    } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        ok(
            /legacy Node\/V8|only Node-API|ERR_DLOPEN|Error loading shared library/i.test(msg),
            msg,
        );
    }
});

Deno.test('process.dlopen: is not unsupported()', () => {
    try {
        process.dlopen({ exports: {} }, '/no/such/addon.node');
    } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        strictEqual(/is not supported/.test(msg), false, msg);
    }
});
