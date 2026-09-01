import { ok, strictEqual } from 'node:assert';
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { makePosixTempDir } from '../_helpers/temp.ts';
import { LockStore } from '../../cts/src/lock.ts';
import { joinPaths } from '../../cts/src/utils/path.ts';

const DB = 'cts.lock';

/** Write a fixed set of entries so two runs differ only by wall-clock time. */
function populate(store: LockStore, root: string): void {
    store.setModule({
        specPath: 'npm:alpha@1.0.0/index.js',
        localPath: joinPaths(root, 'cache', 'alpha', 'index.js'),
        format: 'cjs',
        fileKind: 'source',
    });
    store.setModule({
        specPath: 'npm:beta@2.3.4/lib/b.mjs',
        localPath: joinPaths(root, 'cache', 'beta', 'lib', 'b.mjs'),
        format: 'esm',
        fileKind: 'source',
    });
    store.setSource('alpha', '/project/main.ts', 'npm:alpha@1.0.0/index.js');
    store.setImports('npm:alpha@1.0.0/index.js', ['./dep.js', 'node:fs', 'npm:beta@2.3.4']);
    store.addBin('alpha-cli', joinPaths(root, 'cache', 'alpha', 'cli.js'), 'alpha@1.0.0');
}

Deno.test('cts lock determinism: identical input produces byte-identical lock', () => {
    const a = makePosixTempDir('lock-det-a');
    const b = makePosixTempDir('lock-det-b');
    try {
        // Same logical content, but localPath embeds the root, so normalize by
        // using a constant fake root for the values written into the DB.
        const FAKE = '/fixed/root';
        for (const dir of [a, b]) {
            const store = new LockStore(dir, false);
            populate(store, FAKE);
            store.flush();
            store.close();
        }
        const bytesA = readFileSync(join(a, DB));
        const bytesB = readFileSync(join(b, DB));
        strictEqual(bytesA.length, bytesB.length, 'lock sizes differ');
        strictEqual(Buffer.compare(bytesA, bytesB), 0,
            `lock bytes differ: first mismatch at ${(() => {
                for (let i = 0; i < bytesA.length; i++) if (bytesA[i] !== bytesB[i]) return i;
                return -1;
            })()}`);
    } finally {
        rmSync(a, { recursive: true, force: true });
        rmSync(b, { recursive: true, force: true });
    }
});

Deno.test('cts lock corruption: non-SQLite bytes are recovered, not fatal', () => {
    const root = makePosixTempDir('lock-corrupt-garbage');
    try {
        writeFileSync(join(root, DB), 'this is definitely not a sqlite database\n'.repeat(40));
        const store = new LockStore(root, false);
        populate(store, root);
        store.flush();
        // A recovered store must actually persist and read back.
        const got = store.getModule('npm:alpha@1.0.0/index.js');
        store.close();
        ok(got, 'entry unreadable after recovery from garbage lock');
        strictEqual(got?.format, 'cjs');
        ok(existsSync(join(root, DB + '.bak')), 'corrupt lock was not backed up to .bak');
        // Reopen cold to prove it landed on disk.
        const store2 = new LockStore(root, true);
        const again = store2.getModule('npm:alpha@1.0.0/index.js');
        store2.close();
        ok(again, 'entry did not survive a cold reopen after recovery');
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
});

Deno.test('cts lock corruption: truncated SQLite header is recovered', () => {
    const root = makePosixTempDir('lock-corrupt-trunc');
    try {
        // Build a real lock, then truncate it mid-page.
        const seed = new LockStore(root, false);
        populate(seed, root);
        seed.flush();
        seed.close();
        const full = readFileSync(join(root, DB));
        ok(full.length > 600, `seed lock too small to truncate: ${full.length}`);
        writeFileSync(join(root, DB), full.subarray(0, 600));

        const store = new LockStore(root, false);
        populate(store, root);
        store.flush();
        const got = store.getModule('npm:beta@2.3.4/lib/b.mjs');
        store.close();
        ok(got, 'entry unreadable after recovery from truncated lock');
        strictEqual(got?.format, 'esm');
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
});

Deno.test('cts lock corruption: conflicting schema is recovered', () => {
    const root = makePosixTempDir('lock-corrupt-schema');
    try {
        // A valid SQLite file whose `modules` table has an incompatible shape.
        // CREATE TABLE IF NOT EXISTS will not fix it, so queries must fail and
        // trigger the .bak recovery path.
        const seed = new LockStore(root, false);
        populate(seed, root);
        seed.flush();
        seed.close();
        const bytes = readFileSync(join(root, DB));
        // Corrupt the schema by rewriting the sqlite_master page marker region.
        // Simpler and more honest: drop a hand-rolled DB with a wrong table.
        rmSync(join(root, DB));
        // Reuse sqlite through LockStore is not possible for arbitrary DDL, so
        // emulate "wrong schema" as a file that is SQLite-shaped but garbage
        // past the header (header valid → open succeeds, pages invalid).
        const hdr = Buffer.alloc(bytes.length);
        bytes.copy(hdr, 0, 0, 100);          // keep the 100-byte SQLite header
        hdr.fill(0x5a, 100);                  // garbage pages
        writeFileSync(join(root, DB), hdr);

        const store = new LockStore(root, false);
        populate(store, root);
        store.flush();
        const got = store.getModule('npm:alpha@1.0.0/index.js');
        store.close();
        ok(got, 'entry unreadable after recovery from schema-corrupt lock');
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
});

Deno.test('cts lock: read-only store discards writes and never creates a file', () => {
    const root = makePosixTempDir('lock-readonly');
    try {
        strictEqual(LockStore.existsAt(root), false);
        const store = new LockStore(root, true);
        strictEqual(store.writable, false);
        // Every setter early-returns when readOnly, so writes are dropped by
        // design and no lock file may appear.
        populate(store, root);
        strictEqual(store.dirtyCount, 0, 'read-only store queued pending writes');
        store.flush();
        strictEqual(store.getModule('npm:alpha@1.0.0/index.js'), undefined,
            'read-only store retained a discarded write');
        store.close();
        strictEqual(existsSync(join(root, DB)), false, 'read-only store wrote a lock file');
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
});

Deno.test('cts lock: deleting the lock mid-run does not throw and re-persists', () => {
    const root = makePosixTempDir('lock-unlink-midrun');
    try {
        const store = new LockStore(root, false);
        populate(store, root);
        store.flush();
        ok(existsSync(join(root, DB)));

        // Simulate an external `rm cts.lock` while the store is open.
        try {
            rmSync(join(root, DB), { force: true });
        } catch { /* Windows may hold a lock on the open handle. */ }

        // Further writes must not crash the process.
        store.setModule({
            specPath: 'npm:gamma@3.0.0/g.js',
            localPath: joinPaths(root, 'cache', 'gamma', 'g.js'),
            format: 'cjs',
            fileKind: 'source',
        });
        store.flush();
        const got = store.getModule('npm:gamma@3.0.0/g.js');
        store.close();
        ok(got, 'write after mid-run unlink was lost');
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
});

Deno.test('cts lock: second writer on the same file waits rather than corrupting', () => {
    const root = makePosixTempDir('lock-concurrent');
    try {
        const a = new LockStore(root, false);
        populate(a, root);
        a.flush();

        // Open a second writable store against the same path while the first
        // is still open, then interleave writes.
        const b = new LockStore(root, false);
        b.setModule({
            specPath: 'npm:delta@4.0.0/d.js',
            localPath: joinPaths(root, 'cache', 'delta', 'd.js'),
            format: 'esm',
            fileKind: 'source',
        });
        b.flush();

        a.setModule({
            specPath: 'npm:eps@5.0.0/e.js',
            localPath: joinPaths(root, 'cache', 'eps', 'e.js'),
            format: 'cjs',
            fileKind: 'source',
        });
        a.flush();
        a.close();
        b.close();

        // Both writes must be present and the DB must still be readable.
        const verify = new LockStore(root, true);
        const d = verify.getModule('npm:delta@4.0.0/d.js');
        const e = verify.getModule('npm:eps@5.0.0/e.js');
        const seed = verify.getModule('npm:alpha@1.0.0/index.js');
        verify.close();
        ok(seed, 'first writer entry lost after concurrent access');
        ok(d, 'second writer entry lost');
        ok(e, 'first writer post-concurrency entry lost');
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
});
