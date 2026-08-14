// Parity assertions measured two-column against deno 2.9.3
// (stable, release, x86_64-pc-windows-msvc; v8 14.9.207.2-rusty; typescript 6.0.3),
// both runtimes invoked with `run -A`. Every expectation below was observed
// IDENTICAL in deno 2.9.3 and cno, so each one is a regression guard rather than a
// restatement of cno's own behaviour.
//
// Tests marked `ignore: true` carry the deno-correct expectation for a defect that
// is still open; the comment above each names the defect. They are inert today and
// must be un-ignored by whoever lands the corresponding fix.
import { ok, rejects, strictEqual, throws } from 'node:assert';
import { join } from 'node:path';
import { withTempDir } from '../_helpers/temp.ts';

// deno 2.9.3 exposes exactly these 25 constructors on the namespace.
const DENO_ERROR_NAMES = [
    'AddrInUse', 'AddrNotAvailable', 'AlreadyExists', 'BadResource', 'BrokenPipe', 'Busy',
    'ConnectionAborted', 'ConnectionRefused', 'ConnectionReset', 'FilesystemLoop', 'Http',
    'Interrupted', 'InvalidData', 'IsADirectory', 'NetworkUnreachable', 'NotADirectory',
    'NotCapable', 'NotConnected', 'NotFound', 'NotSupported', 'PermissionDenied', 'TimedOut',
    'UnexpectedEof', 'WouldBlock', 'WriteZero',
];

Deno.test('deno oracle: Deno.errors exposes exactly the 2.9.3 constructor set', () => {
    strictEqual(JSON.stringify(Object.keys(Deno.errors).sort()), JSON.stringify(DENO_ERROR_NAMES));
    for (const name of DENO_ERROR_NAMES) {
        const Ctor = (Deno.errors as unknown as Record<string, new (m?: string) => Error>)[name];
        strictEqual(typeof Ctor, 'function', `${name} must be constructible`);
        const instance = new Ctor('probe');
        ok(instance instanceof Error, `${name} must extend Error`);
        strictEqual(instance.name, name, `${name}.name must match its key`);
        strictEqual(instance.message, 'probe');
    }
});

Deno.test('deno oracle: FsFile read signals EOF with null and empty reads with 0', async () => {
    await withTempDir('deno-oracle-fsfile', async (dir) => {
        const file = join(dir, 'eof.txt');
        await Deno.writeTextFile(file, 'hello');
        const fh = await Deno.open(file, { read: true });
        try {
            // A zero-length read is not EOF: deno returns 0, never null.
            strictEqual(await fh.read(new Uint8Array(0)), 0);

            await fh.seek(0, Deno.SeekMode.End);
            // At EOF a non-empty read returns null, not 0.
            strictEqual(await fh.read(new Uint8Array(4)), null);
        } finally {
            fh.close();
        }
    });
});

Deno.test('deno oracle: operations on a closed FsFile raise BadResource', async () => {
    await withTempDir('deno-oracle-fsfile', async (dir) => {
        const file = join(dir, 'closed.txt');
        await Deno.writeTextFile(file, 'x');
        const fh = await Deno.open(file, { read: true });
        fh.close();

        await rejects(() => fh.stat(), Deno.errors.BadResource);
        // Closing twice is an error in deno, not a silent no-op.
        throws(() => fh.close(), Deno.errors.BadResource);
    });
});

Deno.test('deno oracle: FsFile supports sync disposal only', async () => {
    await withTempDir('deno-oracle-fsfile', async (dir) => {
        const file = join(dir, 'dispose.txt');
        await Deno.writeTextFile(file, 'x');
        const fh = await Deno.open(file, { read: true });
        try {
            strictEqual(typeof (fh as unknown as Record<symbol, unknown>)[Symbol.dispose], 'function');
            // deno 2.9.3 deliberately has no async disposal on FsFile.
            strictEqual(typeof (fh as unknown as Record<symbol, unknown>)[Symbol.asyncDispose], 'undefined');
        } finally {
            fh.close();
        }
    });
});

Deno.test('deno oracle: readDir entries carry exactly four fields and iterate async-only', async () => {
    await withTempDir('deno-oracle-readdir', async (dir) => {
        await Deno.writeTextFile(join(dir, 'a.txt'), 'a');
        await Deno.mkdir(join(dir, 'sub'));

        const iterator = Deno.readDir(dir);
        strictEqual(typeof (iterator as unknown as Record<symbol, unknown>)[Symbol.asyncIterator], 'function');
        // readDir is async-iterable only; the sync protocol is absent.
        strictEqual(typeof (iterator as unknown as Record<symbol, unknown>)[Symbol.iterator], 'undefined');

        const entries = [];
        for await (const entry of iterator) entries.push(entry);
        entries.sort((left, right) => (left.name < right.name ? -1 : 1));

        strictEqual(entries.length, 2);
        strictEqual(JSON.stringify(Object.keys(entries[0]).sort()), JSON.stringify(['isDirectory', 'isFile', 'isSymlink', 'name']));
        strictEqual(`${entries[0].isFile}/${entries[0].isDirectory}/${entries[0].isSymlink}`, 'true/false/false');
        strictEqual(`${entries[1].isFile}/${entries[1].isDirectory}/${entries[1].isSymlink}`, 'false/true/false');
    });
});

Deno.test('deno oracle: stat reports timestamps as Dates and core ids as numbers', async () => {
    await withTempDir('deno-oracle-stat', async (dir) => {
        const file = join(dir, 'meta.txt');
        await Deno.writeTextFile(file, 'meta');
        const info = await Deno.stat(file) as unknown as Record<string, unknown>;

        // All four timestamps are populated Dates on this platform in deno 2.9.3.
        for (const field of ['mtime', 'atime', 'birthtime', 'ctime']) {
            ok(info[field] instanceof Date, `${field} must be a Date`);
        }
        // These are non-null numbers on Windows in deno 2.9.3 (unlike uid/gid/rdev/blksize).
        for (const field of ['dev', 'ino', 'mode', 'nlink', 'blocks']) {
            strictEqual(typeof info[field], 'number', `${field} must be a number`);
        }
        strictEqual(info.isFile, true);
        strictEqual(info.isDirectory, false);
        strictEqual(info.isSymlink, false);
    });
});

Deno.test({ name: 'deno oracle: CommandOutput success always agrees with code', timeout: 20000 }, async () => {
    const failure = await new Deno.Command('cmd', { args: ['/c', 'exit 3'] }).output();
    strictEqual(failure.code, 3);
    strictEqual(failure.success, false);
    strictEqual(failure.signal, null);
    strictEqual(failure.success, failure.code === 0);

    const failureSync = new Deno.Command('cmd', { args: ['/c', 'exit 7'] }).outputSync();
    strictEqual(failureSync.code, 7);
    strictEqual(failureSync.success, false);
    strictEqual(failureSync.success, failureSync.code === 0);
    strictEqual(JSON.stringify(Object.keys(failureSync).sort()), JSON.stringify(['code', 'signal', 'stderr', 'stdout', 'success']));

    const success = await new Deno.Command('cmd', { args: ['/c', 'exit 0'] }).output();
    strictEqual(success.code, 0);
    strictEqual(success.success, true);
    ok(success.stdout instanceof Uint8Array);
    ok(success.stderr instanceof Uint8Array);
});

Deno.test({ name: 'deno oracle: spawning a missing binary fails as NotFound on every entry point', timeout: 20000 }, async () => {
    const missing = 'definitely-not-a-real-binary-cno-oracle';

    // deno raises synchronously from output() while cno returns a rejected promise, so
    // assert through a form that holds either way (see the sync-throw defect below).
    let asyncFailure: (Error & { code?: string }) | undefined;
    try {
        await new Deno.Command(missing).output();
    } catch (error) {
        asyncFailure = error as Error & { code?: string };
    }
    ok(asyncFailure, 'output() must fail for a missing binary');
    ok(asyncFailure instanceof Deno.errors.NotFound, 'output() must fail with NotFound');
    strictEqual(asyncFailure.name, 'NotFound');
    strictEqual(asyncFailure.code, 'ENOENT');

    throws(() => new Deno.Command(missing).outputSync(), Deno.errors.NotFound);
    // spawn() raises synchronously in both runtimes.
    throws(() => new Deno.Command(missing).spawn(), Deno.errors.NotFound);
});

Deno.test({ name: 'deno oracle: env mutation round-trips and rejects malformed keys', timeout: 20000 }, () => {
    const key = 'CNO_ORACLE_ENV_PROBE';
    Deno.env.set(key, 'value-1');
    try {
        strictEqual(Deno.env.get(key), 'value-1');
        strictEqual(Deno.env.has(key), true);
        strictEqual(Deno.env.toObject()[key], 'value-1');
        // Windows environment lookups are case-insensitive in deno 2.9.3.
        strictEqual(Deno.env.get(key.toLowerCase()), 'value-1');
    } finally {
        Deno.env.delete(key);
    }
    strictEqual(Deno.env.get(key), undefined);
    strictEqual(Deno.env.has(key), false);
    strictEqual(Deno.env.get('CNO_ORACLE_ENV_ABSENT'), undefined);

    // Empty, '=' bearing and NUL bearing keys are all rejected, on get as well as set.
    for (const malformed of ['', 'A=B', 'A\0B']) {
        throws(() => Deno.env.set(malformed, 'x'), TypeError);
        throws(() => Deno.env.get(malformed), TypeError);
    }
});

Deno.test('deno oracle: numeric rids survive on stdio and are gone everywhere else', async () => {
    // deno 2.9.3 still exposes rid 0/1/2 on the stdio handles, as a prototype getter
    // rather than an own property, but removed it from every other resource.
    const stdio = [['stdin', Deno.stdin], ['stdout', Deno.stdout], ['stderr', Deno.stderr]] as const;
    stdio.forEach(([name, handle], index) => {
        strictEqual((handle as unknown as Record<string, unknown>).rid, index, `${name}.rid`);
        strictEqual(Object.prototype.hasOwnProperty.call(handle, 'rid'), false, `${name}.rid must not be an own property`);
    });

    await withTempDir('deno-oracle-rid', async (dir) => {
        const file = join(dir, 'rid.txt');
        await Deno.writeTextFile(file, 'x');
        const fh = await Deno.open(file, { read: true });
        strictEqual((fh as unknown as Record<string, unknown>).rid, undefined);
        fh.close();

        const listener = Deno.listen({ hostname: '127.0.0.1', port: 0 });
        strictEqual((listener as unknown as Record<string, unknown>).rid, undefined);
        const { port } = listener.addr as Deno.NetAddr;
        const client = await Deno.connect({ hostname: '127.0.0.1', port });
        const server = await listener.accept();
        strictEqual((client as unknown as Record<string, unknown>).rid, undefined);
        client.close();
        server.close();
        listener.close();
        // A timer spanning the closes keeps the loop demonstrably alive past teardown.
        await new Promise((resolve) => setTimeout(resolve, 60));
    });
});

Deno.test('deno oracle: APIs removed in Deno 2 stay absent', () => {
    // Shipping a removed API is itself a compatibility break, so guard the removals.
    // Verified absent in deno 2.9.3 as well; note that Deno.isatty is deprecated but
    // still present, so it is deliberately not in this list.
    for (const name of ['copy', 'iter', 'iterSync', 'Buffer', 'readAll', 'readAllSync', 'writeAll', 'writeAllSync', 'resources', 'metrics', 'shutdown', 'fstat', 'seek', 'read', 'write', 'flock', 'futime', 'close', 'file', 'ftruncate', 'fdatasync', 'fsync']) {
        strictEqual(typeof (Deno as unknown as Record<string, unknown>)[name], 'undefined', `Deno.${name} was removed in Deno 2`);
    }
    // Deprecated but retained in 2.9.3.
    strictEqual(typeof Deno.isatty, 'function');
});

// ---------------------------------------------------------------------------
// Open defects. Each block holds the deno 2.9.3 expectation. Keep genuinely
// unresolved cases ignored, but run a case as soon as its implementation lands.
// ---------------------------------------------------------------------------

// REGRESSION GUARD (was a defect, fixed 2026-08-10): seekPosition() in
// cno/src/deno/03_fopen.ts used to clamp with Math.max(0, ...) on all three whence
// branches, so a negative target silently became position 0 and a following write
// corrupted the head of the file ("ABCDEFGHIJ" -> "ZZCDEFGHIJ"). It now throws, matching
// deno, which raises os error 131 and leaves the file untouched. The companion assertion
// in tests/deno/fs-file.test.ts had snapshotted the corrupted bytes and has been
// converted to a rejects(); do not re-snapshot this runtime's output there.
Deno.test('deno oracle: negative seek rejects instead of clamping to zero', async () => {
    await withTempDir('deno-oracle-seek', async (dir) => {
        const file = join(dir, 'seek.txt');
        await Deno.writeTextFile(file, 'ABCDEFGHIJ');
        const fh = await Deno.open(file, { read: true, write: true });
        try {
            await rejects(() => fh.seek(-10, Deno.SeekMode.Start));
            await rejects(() => fh.seek(-1, Deno.SeekMode.Start));
            await rejects(() => fh.seek(-100, Deno.SeekMode.End));
            throws(() => fh.seekSync(-3, Deno.SeekMode.Start));
        } finally {
            fh.close();
        }
        // The rejected seeks must not have moved the pointer or touched the bytes.
        strictEqual(await Deno.readTextFile(file), 'ABCDEFGHIJ');
    });
});

// REGRESSION GUARD (was a defect, fixed 2026-08-10): a failed async spawn used to leave
// the uv_process_t linked into the loop handle queue while the fail path in
// circu.js/src/mod_process.c freed the containing struct, so the process segfaulted at
// teardown with exit 139 even though the error had been caught correctly. uv_spawn
// registers the handle via uv__process_init -> uv__handle_init before it can fail, so the
// fail path now hands it to uv_close() instead of tjs__free(). Measured before the fix:
// 13/15 runs exited 139; deno always 0. Verified fixed in the 2026-08-10 12:58 binary.
Deno.test({ name: 'deno oracle: a caught spawn failure still exits cleanly', timeout: 30000 }, async () => {
    const child = await new Deno.Command(Deno.execPath(), {
        args: ['eval', 'try { await new Deno.Command("definitely-not-a-real-binary-cno-oracle").output(); } catch { /* handled */ }'],
        stdout: 'piped',
        stderr: 'piped',
    }).output();
    // Today this observes 139 (SIGSEGV) rather than 0.
    strictEqual(child.code, 0);
    strictEqual(child.success, true);
});

// DEFECT: clearEnv leaks libuv's required_vars[] on the async path only. deno leaves
// just the three cmd.exe injects (COMSPEC, PATHEXT, PROMPT); cno's output()/spawn()
// additionally pass through PATH, USERNAME, USERPROFILE, USERDOMAIN, LOGONSERVER,
// HOMEDRIVE, HOMEPATH, TEMP, SYSTEMDRIVE, SYSTEMROOT and WINDIR.
// Root cause: circu.js/deps/libuv/src/win/process.c:50-62 required_vars[], merged by
// uv_spawn. outputSync() uses CreateProcessW directly and is already correct.
Deno.test({ name: 'deno oracle: clearEnv clears the async child env as thoroughly as the sync one', ignore: true, timeout: 20000 }, async () => {
    const names = (bytes: Uint8Array) =>
        new TextDecoder().decode(bytes)
            .split(/\r?\n/)
            .map((line) => line.split('=')[0])
            .filter((name) => name.length > 0)
            .map((name) => name.toUpperCase())
            .sort();

    const asyncNames = names((await new Deno.Command('cmd', { args: ['/c', 'set'], clearEnv: true }).output()).stdout);
    const syncNames = names(new Deno.Command('cmd', { args: ['/c', 'set'], clearEnv: true }).outputSync().stdout);

    strictEqual(JSON.stringify(syncNames), JSON.stringify(['COMSPEC', 'PATHEXT', 'PROMPT']));
    strictEqual(JSON.stringify(asyncNames), JSON.stringify(syncNames));
});

// DEFECT: the no-records path raises a bare Error, so
// `catch (e) { if (e instanceof Deno.errors.NotFound) }` never matches. deno raises
// Deno.errors.NotFound for both NXDOMAIN and a name that exists without the record type.
Deno.test({ name: 'deno oracle: resolveDns raises NotFound when there are no records', ignore: true, timeout: 20000 }, async () => {
    await rejects(() => Deno.resolveDns('nonexistent-cno-oracle-probe.invalid', 'A'), Deno.errors.NotFound);
    // example.com exists but has no CNAME, which is the same no-answer path.
    await rejects(() => Deno.resolveDns('example.com', 'CNAME'), Deno.errors.NotFound);
});

// DEFECT: wrong-mode handle IO reports BadResource, which means "closed or invalid
// resource". The handle is valid and only the access mode is wrong, which deno
// reports as PermissionDenied.
Deno.test({ name: 'deno oracle: wrong-mode handle IO raises PermissionDenied', ignore: true }, async () => {
    await withTempDir('deno-oracle-mode', async (dir) => {
        const file = join(dir, 'mode.txt');
        await Deno.writeTextFile(file, 'x');

        const readOnly = await Deno.open(file, { read: true });
        try {
            await rejects(() => readOnly.write(new Uint8Array([1])), Deno.errors.PermissionDenied);
        } finally {
            readOnly.close();
        }

        const writeOnly = await Deno.open(file, { write: true });
        try {
            await rejects(() => writeOnly.read(new Uint8Array(4)), Deno.errors.PermissionDenied);
        } finally {
            writeOnly.close();
        }
    });
});

// DEFECT: output() refuses stdout:'inherit' (and 'null') with an eager TypeError, so the
// command never runs. deno runs it, resolves, and only throws lazily if you touch the
// non-piped .stdout getter -- so `await cmd.output()` for an exit code while letting the
// child's output through works in deno and is unusable in cno.
Deno.test({ name: 'deno oracle: output() runs the child when stdout is inherited', ignore: true, timeout: 20000 }, async () => {
    const result = await new Deno.Command('cmd', { args: ['/c', 'echo inherited'], stdout: 'inherit' }).output();
    strictEqual(result.success, true);
    strictEqual(result.code, 0);
    strictEqual(JSON.stringify(Object.keys(result).sort()), JSON.stringify(['code', 'signal', 'stderr', 'stdout', 'success']));
    // stderr was still piped, so it reads normally.
    strictEqual(result.stderr.length, 0);
    // The non-piped stream is a throwing getter rather than an empty buffer.
    throws(() => result.stdout.length, TypeError);
});

// DEFECT: Deno.build is missing the `env` field present in deno 2.9.3.
Deno.test({ name: 'deno oracle: Deno.build carries the 2.9.3 field set', ignore: true }, () => {
    strictEqual(
        JSON.stringify(Object.keys(Deno.build).sort()),
        JSON.stringify(['arch', 'env', 'os', 'standalone', 'target', 'vendor']),
    );
});

// DEFECT: Command.output() reports a spawn failure as a rejected promise, but deno
// 2.9.3 raises it synchronously from the call itself, so
// `try { cmd.output() } catch {}` (no await) catches in deno and escapes in cno.
// outputSync() and spawn() already raise synchronously in both.
Deno.test({ name: 'deno oracle: output() reports spawn failure synchronously', ignore: true, timeout: 20000 }, () => {
    throws(() => {
        // Deliberately not awaited: the throw must happen during the call.
        void new Deno.Command('definitely-not-a-real-binary-cno-oracle').output();
    }, Deno.errors.NotFound);
});

// DEFECT: watchFs maps node's two-event vocabulary straight onto deno's, at
// cno/src/deno/02_fs.ts:368 (`ev === 'rename' ? 'rename' : 'modify'`), so 'create' and
// 'remove' are never emitted -- a created file reports 'rename' and a deleted one is
// indistinguishable. The canonical `if (event.kind === 'create')` watcher never fires.
Deno.test({ name: 'deno oracle: watchFs reports create and remove kinds', ignore: true, timeout: 30000 }, async () => {
    await withTempDir('deno-oracle-watch', async (dir) => {
        const collect = async (act: () => Promise<void>) => {
            const watcher = Deno.watchFs(dir);
            const kinds: string[] = [];
            const pump = (async () => { for await (const event of watcher) kinds.push(event.kind); })();
            await new Promise((resolve) => setTimeout(resolve, 250));
            await act();
            await new Promise((resolve) => setTimeout(resolve, 1200));
            try { watcher.close(); } catch { /* already closed */ }
            try { await pump; } catch { /* closing ends the iterator */ }
            return kinds;
        };

        const created = await collect(async () => { await Deno.writeTextFile(join(dir, 'made.txt'), 'a'); });
        ok(created.includes('create'), `expected a create event, saw ${JSON.stringify(created)}`);

        const removed = await collect(async () => { await Deno.remove(join(dir, 'made.txt')); });
        ok(removed.includes('remove'), `expected a remove event, saw ${JSON.stringify(removed)}`);
    });
});

// DEFECT: FsEvent is missing the `flag` field; deno 2.9.3 exposes
// ["flag", "kind", "paths"].
Deno.test({ name: 'deno oracle: FsEvent carries the 2.9.3 field set', ignore: true, timeout: 30000 }, async () => {
    await withTempDir('deno-oracle-watch', async (dir) => {
        const watcher = Deno.watchFs(dir);
        let seen: Deno.FsEvent | undefined;
        const pump = (async () => { for await (const event of watcher) { seen = event; break; } })();
        await new Promise((resolve) => setTimeout(resolve, 250));
        await Deno.writeTextFile(join(dir, 'shape.txt'), 'a');
        await Promise.race([pump, new Promise((resolve) => setTimeout(resolve, 3000))]);
        try { watcher.close(); } catch { /* already closed */ }

        ok(seen, 'expected at least one event');
        strictEqual(JSON.stringify(Object.keys(seen).sort()), JSON.stringify(['flag', 'kind', 'paths']));
    });
});

// DEFECT: Deno.listen does not validate `port`, at cno/src/deno/05_net.ts:196-207
// (`port: opt.port ?? 80` handed straight to bind, which truncates to 16 bits). An
// out-of-range port silently binds a DIFFERENT port: 70000 -> 4464, -1 -> 65535,
// 1.5 -> 1. Omitting the port binds 80 where deno picks an ephemeral one.
Deno.test({ name: 'deno oracle: listen rejects out-of-range ports instead of wrapping them', ignore: true }, () => {
    for (const port of [70000, 65536, -1, 4294967296]) {
        throws(() => Deno.listen({ hostname: '127.0.0.1', port }).close(), RangeError, `port ${port} must be rejected`);
    }
    for (const port of [1.5, NaN]) {
        throws(() => Deno.listen({ hostname: '127.0.0.1', port }).close(), TypeError, `port ${port} must be rejected`);
    }
    // listenTls repeats the pattern with a different default (cno/src/deno/05_net.ts:1235,
    // `opt.port ?? 443`), so it needs the same guard.
    throws(() => Deno.listenTls({ hostname: '127.0.0.1', port: 70000, cert: '', key: '' }).close(), RangeError);
});

// DEFECT: Deno.inspect ignores `sorted`, does not label `getters`, leaves a top-level
// string unquoted, quotes with ' instead of ", and defaults to depth 2 rather than 4.
Deno.test({ name: 'deno oracle: Deno.inspect honours its documented options', ignore: true }, () => {
    // A bare string is rendered as its quoted literal.
    strictEqual(Deno.inspect('hi'), '"hi"');
    strictEqual(Deno.inspect({ b: 'x' }), '{ b: "x" }');
    // sorted reorders keys.
    strictEqual(Deno.inspect({ b: 1, a: 2 }, { sorted: true }), '{ a: 2, b: 1 }');
    // getters are labelled rather than silently evaluated.
    strictEqual(
        Deno.inspect(Object.defineProperty({}, 'g', { get: () => 5, enumerable: true }), { getters: true }),
        '{ g: [Getter: 5] }',
    );
    // The default depth reaches four levels.
    ok(!Deno.inspect({ a: { b: { c: { d: 1 } } } }).includes('[Object]'));
});

// DEFECT: Deno.build.vendor reports "cno" where deno reports "pc", which contradicts
// build.target (x86_64-pc-windows-msvc) and breaks target-triple parsing.
Deno.test({ name: 'deno oracle: Deno.build.vendor matches the target triple', ignore: true }, () => {
    strictEqual(Deno.build.vendor, 'pc');
    ok(Deno.build.target.includes(`-${Deno.build.vendor}-`), 'vendor must appear in the target triple');
});

// DEFECT: resolveDns queries the configured nameserver directly
// (cno/src/deno/05_net.ts:1113-1198 builds a wire query via dns.query), so it never
// consults the hosts file and 'localhost' cannot resolve at all -- deno returns one
// record. Separately, every no-records outcome surfaces as a bare Error whose message
// blames parsing ("Failed to parse DNS response") rather than Deno.errors.NotFound.
Deno.test({ name: 'deno oracle: resolveDns resolves hosts-file names like localhost', ignore: true, timeout: 20000 }, async () => {
    const records = await Deno.resolveDns('localhost', 'A');
    ok(Array.isArray(records), 'resolveDns must return an array');
    ok(records.length > 0, 'localhost must resolve to at least one address');
});
