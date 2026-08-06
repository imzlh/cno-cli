/**
 * Recursive readdir/opendir across the three Windows link kinds.
 *
 * Every expectation here was measured against real node v24.18.0 on Windows 11.
 * The two headline facts, because they are counter-intuitive:
 *
 *  1. A junction and a directory symlink are INDISTINGUISHABLE at the dirent
 *     level. Node reports `isDirectory()===false, isSymbolicLink()===true` for
 *     both (libuv tests FILE_ATTRIBUTE_REPARSE_POINT before
 *     FILE_ATTRIBUTE_DIRECTORY). So the dirent type cannot be used to decide
 *     whether to descend.
 *  2. Node uses TWO DIFFERENT descend gates and they disagree with each other:
 *       - readdirSync / readdir(cb), both with and without withFileTypes, and
 *         fsp.readdir WITHOUT withFileTypes -> descend into anything that
 *         *resolves* to a directory, so junctions AND directory symlinks are
 *         walked.
 *       - fsp.readdir WITH withFileTypes, and every opendir form -> descend
 *         only into real directories, so no reparse point is ever walked.
 */

import { deepStrictEqual, ok, strictEqual, throws } from 'node:assert';
import * as fs from 'node:fs';
import * as fsp from 'node:fs/promises';
import { join } from 'node:path';
import { withTempDir } from '../_helpers/temp.ts';

const isWindows = Deno.build.os === 'windows';

interface Fixture {
    /** The directory the tests walk. */
    walk: string;
    /** Which link kinds this machine actually allowed us to create. */
    have: { jnc: boolean; dsym: boolean; fsym: boolean };
}

/**
 * walk/
 *   plain.txt
 *   realdir/r1.txt
 *   jnc   -> ../target     (junction, needs no elevation)
 *   dsym  -> ../target     (directory symlink, needs privilege -> may be absent)
 *   fsym  -> ../tfile.txt  (file symlink, needs privilege -> may be absent)
 * target/
 *   file2.txt
 *   deep/file3.txt
 */
function build(root: string): Fixture {
    const target = join(root, 'target');
    const walk = join(root, 'walk');
    fs.mkdirSync(join(target, 'deep'), { recursive: true });
    fs.writeFileSync(join(target, 'file2.txt'), 'f2');
    fs.writeFileSync(join(target, 'deep', 'file3.txt'), 'f3');
    fs.writeFileSync(join(root, 'tfile.txt'), 'tf');
    fs.mkdirSync(join(walk, 'realdir'), { recursive: true });
    fs.writeFileSync(join(walk, 'plain.txt'), 'p');
    fs.writeFileSync(join(walk, 'realdir', 'r1.txt'), 'r1');

    const have = { jnc: false, dsym: false, fsym: false };
    // A junction needs no elevation; the two symlink kinds do, so an EPERM here
    // is a Windows privilege matter and those assertions are skipped.
    try { fs.symlinkSync(target, join(walk, 'jnc'), 'junction'); have.jnc = true; } catch { /* unavailable */ }
    try { fs.symlinkSync(target, join(walk, 'dsym'), 'dir'); have.dsym = true; } catch { /* unavailable */ }
    try { fs.symlinkSync(join(root, 'tfile.txt'), join(walk, 'fsym'), 'file'); have.fsym = true; } catch { /* unavailable */ }
    return { walk, have };
}

const slash = (s: unknown) => String(s).replaceAll('\\', '/');
const sorted = (l: unknown[]) => l.map(slash).sort();

/** Entries always present regardless of which links could be created. */
function baseNames(have: Fixture['have']): string[] {
    const n = ['plain.txt', 'realdir'];
    if (have.jnc) n.push('jnc');
    if (have.dsym) n.push('dsym');
    if (have.fsym) n.push('fsym');
    return n;
}

/** What the 'follow' gate must produce: link targets walked. */
function followExpected(have: Fixture['have']): string[] {
    const out = [...baseNames(have), 'realdir/r1.txt'];
    for (const link of ['jnc', 'dsym'] as const) {
        if (!have[link]) continue;
        out.push(`${link}/deep`, `${link}/file2.txt`, `${link}/deep/file3.txt`);
    }
    return out.sort();
}

/** What the 'strict' gate must produce: no reparse point walked. */
function strictExpected(have: Fixture['have']): string[] {
    return [...baseNames(have), 'realdir/r1.txt'].sort();
}

/** Dirent -> compact predicate string, so a wrong predicate is visible. */
function flags(d: fs.Dirent): string {
    return (d.isFile() ? 'F' : '-') +
        (d.isDirectory() ? 'D' : '-') +
        (d.isSymbolicLink() ? 'L' : '-') +
        (d.isFIFO() ? 'P' : '-') +
        (d.isSocket() ? 'S' : '-') +
        (d.isCharacterDevice() ? 'C' : '-') +
        (d.isBlockDevice() ? 'B' : '-');
}

/** Dirent from a recursive walk -> path relative to the walk root. */
function relOf(walk: string, d: fs.Dirent): string {
    const parent = slash(d.parentPath);
    const base = slash(walk);
    const tail = parent === base ? '' : parent.slice(base.length + 1) + '/';
    return tail + String(d.name);
}

function readdirCb(path: string, options?: unknown): Promise<unknown[]> {
    return new Promise((resolve, reject) => {
        const done = (err: unknown, list: unknown) => err ? reject(err) : resolve(list as unknown[]);
        if (options === undefined) fs.readdir(path, done as never);
        else fs.readdir(path, options as never, done as never);
    });
}

function opendirCb(path: string, options?: unknown): Promise<fs.Dir> {
    return new Promise((resolve, reject) => {
        const done = (err: unknown, dir: unknown) => err ? reject(err) : resolve(dir as fs.Dir);
        if (options === undefined) fs.opendir(path, done as never);
        else fs.opendir(path, options as never, done as never);
    });
}

async function drain(dir: fs.Dir): Promise<fs.Dirent[]> {
    const out: fs.Dirent[] = [];
    for await (const entry of dir) out.push(entry);
    return out;
}

// ---------------------------------------------------------------------------

Deno.test({
    name: 'fs links: a junction and a directory symlink are both reported as symlinks, never directories',
    ignore: !isWindows,
    async fn() {
        await withTempDir('fs-links-dirent', async (root) => {
            const { walk, have } = build(root);
            ok(have.jnc, 'a junction must be creatable without elevation');

            const byName = new Map<string, string>();
            for (const d of fs.readdirSync(walk, { withFileTypes: true })) byName.set(String(d.name), flags(d));

            // The measured answer: identical predicates for all three link kinds.
            strictEqual(byName.get('jnc'), '--L----');
            if (have.dsym) strictEqual(byName.get('dsym'), '--L----');
            if (have.fsym) strictEqual(byName.get('fsym'), '--L----');
            strictEqual(byName.get('realdir'), '-D-----');
            strictEqual(byName.get('plain.txt'), 'F------');

            // Same classification through the async and opendir surfaces.
            const viaPromises = new Map<string, string>();
            for (const d of await fsp.readdir(walk, { withFileTypes: true })) viaPromises.set(String(d.name), flags(d));
            strictEqual(viaPromises.get('jnc'), '--L----');

            const viaOpendir = new Map<string, string>();
            for (const d of await drain(await fsp.opendir(walk))) viaOpendir.set(String(d.name), flags(d));
            strictEqual(viaOpendir.get('jnc'), '--L----');

            const viaOpendirSync = new Map<string, string>();
            const dir = fs.opendirSync(walk);
            for (let e = dir.readSync(); e !== null; e = dir.readSync()) viaOpendirSync.set(String(e.name), flags(e));
            dir.closeSync();
            strictEqual(viaOpendirSync.get('jnc'), '--L----');
        });
    },
});

Deno.test({
    name: 'fs links: recursive readdirSync descends into junctions and directory symlinks but not file symlinks',
    ignore: !isWindows,
    async fn() {
        await withTempDir('fs-links-sync-rec', async (root) => {
            const { walk, have } = build(root);
            ok(have.jnc);

            deepStrictEqual(sorted(fs.readdirSync(walk, { recursive: true })), followExpected(have));

            // withFileTypes uses the same gate here — names are leaf basenames and
            // parentPath is the real container, so rebuild the relative path.
            const dirents = fs.readdirSync(walk, { withFileTypes: true, recursive: true });
            deepStrictEqual(dirents.map((d) => relOf(walk, d)).sort(), followExpected(have));

            // A file symlink is listed but never descended into.
            if (have.fsym) {
                const all = fs.readdirSync(walk, { recursive: true }).map(slash);
                deepStrictEqual(all.filter((s) => s.startsWith('fsym/')), []);
                ok(all.includes('fsym'));
            }

            // The junction's own subtree really is reachable through the link path.
            const viaLink = fs.readdirSync(join(walk, 'jnc'), { recursive: true });
            deepStrictEqual(sorted(viaLink), ['deep', 'deep/file3.txt', 'file2.txt']);
        });
    },
});

Deno.test({
    name: 'fs links: recursive callback readdir matches recursive readdirSync for both gates',
    ignore: !isWindows,
    async fn() {
        await withTempDir('fs-links-cb-rec', async (root) => {
            const { walk, have } = build(root);
            ok(have.jnc);

            deepStrictEqual(sorted(await readdirCb(walk, { recursive: true })), followExpected(have));

            const dirents = await readdirCb(walk, { withFileTypes: true, recursive: true }) as fs.Dirent[];
            deepStrictEqual(dirents.map((d) => relOf(walk, d)).sort(), followExpected(have));
        });
    },
});

Deno.test({
    name: 'fs links: fsp.readdir follows links for plain names but not with withFileTypes',
    ignore: !isWindows,
    async fn() {
        await withTempDir('fs-links-fsp-rec', async (root) => {
            const { walk, have } = build(root);
            ok(have.jnc);

            // Plain names: the permissive gate, same as readdirSync.
            deepStrictEqual(sorted(await fsp.readdir(walk, { recursive: true })), followExpected(have));

            // withFileTypes: the strict gate. This asymmetry is Node's, measured —
            // fsp.readdir disagrees with readdirSync on the very same directory.
            const dirents = await fsp.readdir(walk, { withFileTypes: true, recursive: true });
            deepStrictEqual(dirents.map((d) => relOf(walk, d)).sort(), strictExpected(have));
            ok(dirents.every((d) => relOf(walk, d) !== 'jnc/file2.txt'));
        });
    },
});

Deno.test({
    name: 'fs links: opendir recursive walks real directories only and reports container parentPath',
    ignore: !isWindows,
    async fn() {
        await withTempDir('fs-links-opendir-rec', async (root) => {
            const { walk, have } = build(root);
            ok(have.jnc);
            const expected = strictExpected(have);

            // opendirSync — the recursive option used to be ignored outright.
            const syncDir = fs.opendirSync(walk, { recursive: true });
            strictEqual(slash(syncDir.path), slash(walk), 'dir.path stays the walk root');
            const syncEntries: fs.Dirent[] = [];
            for (let e = syncDir.readSync(); e !== null; e = syncDir.readSync()) syncEntries.push(e);
            deepStrictEqual(syncEntries.map((d) => relOf(walk, d)).sort(), expected);
            // Node keeps returning null past exhaustion rather than throwing.
            strictEqual(syncDir.readSync(), null);
            syncDir.closeSync();

            // fsp.opendir
            const promiseDir = await fsp.opendir(walk, { recursive: true });
            strictEqual(slash(promiseDir.path), slash(walk));
            deepStrictEqual((await drain(promiseDir)).map((d) => relOf(walk, d)).sort(), expected);

            // callback opendir
            const cbDir = await opendirCb(walk, { recursive: true });
            deepStrictEqual((await drain(cbDir)).map((d) => relOf(walk, d)).sort(), expected);

            // A nested entry's parentPath is its real container, not the root.
            const nested = syncEntries.find((d) => String(d.name) === 'r1.txt');
            ok(nested !== undefined, 'recursive opendir must reach realdir/r1.txt');
            strictEqual(slash(nested.parentPath), slash(join(walk, 'realdir')));
        });
    },
});

Deno.test({
    name: 'fs links: opendir read past exhaustion keeps returning null',
    ignore: !isWindows,
    async fn() {
        await withTempDir('fs-links-opendir-end', async (root) => {
            const { walk } = build(root);
            for (const options of [undefined, { recursive: true }]) {
                const dir = options === undefined ? await fsp.opendir(walk) : await fsp.opendir(walk, options);
                let count = 0;
                while (await dir.read() !== null) count++;
                ok(count > 0);
                // A second and third read must not throw (the native handle yields
                // undefined here, which used to surface as a TypeError).
                strictEqual(await dir.read(), null);
                strictEqual(await dir.read(), null);
                await dir.close();
            }
        });
    },
});

Deno.test({
    name: 'fs links: a recursive walk emits every entry of a level before the next level',
    ignore: !isWindows,
    async fn() {
        await withTempDir('fs-links-bfs', async (root) => {
            const { walk, have } = build(root);
            ok(have.jnc);

            // Node's recursive readdirSync is breadth-first; a depth-first walk
            // interleaves the levels. Assert the structural property, not the
            // sibling order, which follows the underlying directory order.
            const depths = fs.readdirSync(walk, { recursive: true })
                .map((s) => slash(s).split('/').length);
            for (let i = 1; i < depths.length; i++) {
                ok(depths[i]! >= depths[i - 1]!, `level order broke at index ${i}: ${depths.join(',')}`);
            }

            const opendirDepths = (await drain(await fsp.opendir(walk, { recursive: true })))
                .map((d) => relOf(walk, d).split('/').length);
            for (let i = 1; i < opendirDepths.length; i++) {
                ok(opendirDepths[i]! >= opendirDepths[i - 1]!, 'opendir recursive must be breadth-first');
            }
        });
    },
});

Deno.test({
    name: 'fs links: broken, relative and chained links are listed without aborting the walk',
    ignore: !isWindows,
    async fn() {
        await withTempDir('fs-links-edge', async (root) => {
            const walk = join(root, 'walk');
            fs.mkdirSync(join(walk, 'sub'), { recursive: true });
            fs.writeFileSync(join(walk, 'sub', 's.txt'), 's');

            const made = { broken: false, rel: false, chain: false };
            // Broken junction: the target never exists.
            try { fs.symlinkSync(join(root, 'nope-dir'), join(walk, 'bjnc'), 'junction'); made.broken = true; } catch { /* unavailable */ }
            // Relative directory symlink: resolved against the link's own directory.
            try { fs.symlinkSync('sub', join(walk, 'relsym'), 'dir'); made.rel = true; } catch { /* unavailable */ }
            // Link to a link.
            if (made.rel) {
                try { fs.symlinkSync(join(walk, 'relsym'), join(walk, 'chain'), 'dir'); made.chain = true; } catch { /* unavailable */ }
            }

            const names = fs.readdirSync(walk, { recursive: true }).map(slash);

            // A broken link is listed and simply not descended into — no throw.
            if (made.broken) {
                ok(names.includes('bjnc'));
                deepStrictEqual(names.filter((s) => s.startsWith('bjnc/')), []);
            }
            // A relative target resolves against the link's directory, so the
            // walk reaches through it.
            if (made.rel) deepStrictEqual(names.filter((s) => s.startsWith('relsym/')), ['relsym/s.txt']);
            if (made.chain) deepStrictEqual(names.filter((s) => s.startsWith('chain/')), ['chain/s.txt']);
            ok(names.includes('sub/s.txt'));

            // The strict gate refuses every one of them.
            const strict = (await fsp.readdir(walk, { withFileTypes: true, recursive: true }))
                .map((d) => relOf(walk, d));
            if (made.rel) deepStrictEqual(strict.filter((s) => s.startsWith('relsym/')), []);
        });
    },
});

Deno.test({
    name: 'fs links: a junction cycle terminates instead of walking forever',
    ignore: !isWindows,
    async fn() {
        await withTempDir('fs-links-cycle', async (root) => {
            const walk = join(root, 'walk');
            fs.mkdirSync(join(walk, 'a'), { recursive: true });
            fs.writeFileSync(join(walk, 'a', 'leaf.txt'), 'x');
            let made = false;
            try { fs.symlinkSync(walk, join(walk, 'a', 'loop'), 'junction'); made = true; } catch { /* unavailable */ }
            ok(made, 'a self-referential junction must be creatable');

            // Windows refuses to resolve a path past ~64 reparse traversals
            // (measured: the cutoff tracks the junction count, not the path
            // length), so the follow gate stops on its own. The strict gate never
            // enters the loop at all.
            const strict = await fsp.readdir(walk, { withFileTypes: true, recursive: true });
            deepStrictEqual(strict.map((d) => relOf(walk, d)).sort(), ['a', 'a/leaf.txt', 'a/loop']);

            const strictOpendir = await drain(await fsp.opendir(walk, { recursive: true }));
            deepStrictEqual(strictOpendir.map((d) => relOf(walk, d)).sort(), ['a', 'a/leaf.txt', 'a/loop']);
        });
    },
});

Deno.test('fs links: options.recursive is type-checked by readdirSync and callback readdir only', async () => {
    await withTempDir('fs-links-optval', async (root) => {
        const { walk } = build(root);

        // readdirSync rejects a non-boolean.
        for (const bad of ['yes', 1]) {
            throws(
                () => fs.readdirSync(walk, { recursive: bad as never }),
                (err: unknown) => {
                    strictEqual((err as NodeJS.ErrnoException).code, 'ERR_INVALID_ARG_TYPE');
                    ok(String((err as Error).message).includes('options.recursive'));
                    return true;
                },
            );
        }

        // The callback form throws synchronously, before the callback runs.
        throws(
            () => fs.readdir(walk, { recursive: 'yes' as never }, () => {}),
            (err: unknown) => strictEqual((err as NodeJS.ErrnoException).code, 'ERR_INVALID_ARG_TYPE') ?? true,
        );

        // null/undefined are accepted and mean non-recursive.
        strictEqual(fs.readdirSync(walk, { recursive: null as never }).length, fs.readdirSync(walk).length);

        // fsp.readdir and opendir skip the check and coerce truthily instead.
        const top = fs.readdirSync(walk).length;
        ok((await fsp.readdir(walk, { recursive: 'yes' as never })).length > top);
        const dir = fs.opendirSync(walk, { recursive: 'yes' as never });
        let n = 0;
        for (let e = dir.readSync(); e !== null; e = dir.readSync()) n++;
        dir.closeSync();
        ok(n > top, 'opendir must treat a truthy recursive as recursive');
    });
});

Deno.test('fs links: non-recursive readdir and opendir are unchanged by the recursive walk rework', async () => {
    await withTempDir('fs-links-plain', async (root) => {
        const { walk, have } = build(root);
        const expected = baseNames(have).sort();

        deepStrictEqual(sorted(fs.readdirSync(walk)), expected);
        deepStrictEqual(sorted(await fsp.readdir(walk)), expected);
        deepStrictEqual(sorted(await readdirCb(walk)), expected);
        deepStrictEqual(fs.readdirSync(walk, { withFileTypes: true }).map((d) => String(d.name)).sort(), expected);
        deepStrictEqual((await drain(await fsp.opendir(walk))).map((d) => String(d.name)).sort(), expected);

        // Every non-recursive dirent's parentPath is the directory itself.
        for (const d of fs.readdirSync(walk, { withFileTypes: true })) {
            strictEqual(slash(d.parentPath), slash(walk));
        }
    });
});
