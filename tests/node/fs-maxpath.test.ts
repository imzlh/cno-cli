/**
 * Windows MAX_PATH: fs must reach past the 260-char Win32 budget.
 *
 * Every expectation here was measured against real node v24.18.0 on Windows 11.
 * Before `src/node/fs/syspath.ts` existed, cno's ceilings were (total path
 * length, drive-absolute) while Node had none in the range tested (240..520):
 *
 *   stat lstat access exists open read write copy rename realpath ……… 259
 *   readdir opendir rm -r ……………………………………………………………………………………………………… 257  (`\*` suffix)
 *   mkdir {recursive} ………………………………………………………………………………………………………… 247  (MAX_PATH-12)
 *
 * Two properties matter as much as the reach itself:
 *
 *  1. A thrown error must report the path the CALLER passed. Node never leaks
 *     `\\?\` into `err.path` or the message, so neither may cno.
 *  2. `\\?\` switches OFF Win32 path normalisation, so `.`, `..` and forward
 *     slashes stop being resolved by the OS. They must be resolved BEFORE the
 *     prefix goes on, or a path containing `..` breaks where it used to work.
 */

import { ok, strictEqual } from 'node:assert';
import * as fs from 'node:fs';
import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
import { withTempDir } from '../_helpers/temp.ts';

const isWindows = Deno.build.os === 'windows';
const SEG = 'p'.repeat(39);

/** A path of exactly `total` chars under `root`: short chain + one long tail. */
function pathOfLength(root: string, total: number): string {
    let p = root;
    if (total - p.length < 2) throw new Error(`total=${total} too small for root ${p.length}`);
    while (total - p.length > 201) p += `\\${SEG}`;
    return `${p}\\${'z'.repeat(total - p.length - 1)}`;
}

/** Build a real directory at exactly `total` chars, holding one file `c`. */
function makeDeepDir(root: string, total: number): string {
    const dir = pathOfLength(root, total);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(`${dir}\\c`, 'CHILD');
    return dir;
}

Deno.test({
    name: 'fs maxpath: sync APIs reach well past MAX_PATH',
    ignore: !isWindows,
    fn: () => withTempDir('maxpath-sync', (tmp) => {
        // 300 and 400 both sat far beyond every measured pre-fix ceiling.
        const results: Array<[string, unknown, unknown]> = [];
        for (const total of [300, 400]) {
            const dir = makeDeepDir(path.join(tmp, 'd'), total);
            const file = `${dir}\\c`;
            strictEqual(dir.length, total, 'fixture length');

            results.push([`exists@${total}`, fs.existsSync(dir), true]);
            results.push([`stat@${total}`, fs.statSync(dir).isDirectory(), true]);
            results.push([`lstat@${total}`, fs.lstatSync(dir).isDirectory(), true]);
            results.push([`access@${total}`, fs.accessSync(dir), undefined]);
            results.push([`readdir@${total}`, fs.readdirSync(dir).join(), 'c']);
            results.push([`readFile@${total}`, fs.readFileSync(file, 'utf8'), 'CHILD']);
            results.push([`realpath@${total}`, fs.realpathSync(dir), dir]);

            const d = fs.opendirSync(dir);
            results.push([`opendir.path@${total}`, d.path, dir]);
            d.closeSync();

            fs.writeFileSync(`${dir}\\w`, 'W');
            results.push([`writeFile@${total}`, fs.readFileSync(`${dir}\\w`, 'utf8'), 'W']);
            fs.copyFileSync(file, `${dir}\\c2`);
            results.push([`copyFile@${total}`, fs.readFileSync(`${dir}\\c2`, 'utf8'), 'CHILD']);
            fs.renameSync(`${dir}\\c2`, `${dir}\\c3`);
            results.push([`rename@${total}`, fs.readFileSync(`${dir}\\c3`, 'utf8'), 'CHILD']);

            // rm -r had the 257 ceiling and is the walk that used to abort.
            const victim = makeDeepDir(path.join(tmp, 'r'), total);
            fs.rmSync(victim, { recursive: true });
            results.push([`rm -r@${total}`, fs.existsSync(victim), false]);
        }
        // Assert only after every filesystem call is done, so a teardown
        // failure can never fabricate or mask a result.
        for (const [label, actual, expected] of results) strictEqual(actual, expected, label);
    }),
});

Deno.test({
    name: 'fs maxpath: promises APIs reach well past MAX_PATH',
    ignore: !isWindows,
    fn: () => withTempDir('maxpath-async', async (tmp) => {
        const results: Array<[string, unknown, unknown]> = [];
        const total = 350;
        const dir = makeDeepDir(path.join(tmp, 'd'), total);
        const file = `${dir}\\c`;

        results.push(['fsp.stat', (await fsp.stat(dir)).isDirectory(), true]);
        results.push(['fsp.lstat', (await fsp.lstat(dir)).isDirectory(), true]);
        results.push(['fsp.access', await fsp.access(dir), undefined]);
        results.push(['fsp.readdir', (await fsp.readdir(dir)).join(), 'c']);
        results.push(['fsp.readFile', await fsp.readFile(file, 'utf8'), 'CHILD']);
        results.push(['fsp.realpath', await fsp.realpath(dir), dir]);

        const d = await fsp.opendir(dir);
        results.push(['fsp.opendir.path', d.path, dir]);
        await d.close();

        const h = await fsp.open(file, 'r');
        await h.close();
        results.push(['fsp.open', 'opened', 'opened']);

        await fsp.writeFile(`${dir}\\w`, 'W');
        results.push(['fsp.writeFile', await fsp.readFile(`${dir}\\w`, 'utf8'), 'W']);
        await fsp.copyFile(file, `${dir}\\c2`);
        results.push(['fsp.copyFile', await fsp.readFile(`${dir}\\c2`, 'utf8'), 'CHILD']);
        await fsp.rename(`${dir}\\c2`, `${dir}\\c3`);
        results.push(['fsp.rename', await fsp.readFile(`${dir}\\c3`, 'utf8'), 'CHILD']);

        const victim = makeDeepDir(path.join(tmp, 'r'), total);
        await fsp.rm(victim, { recursive: true });
        results.push(['fsp.rm -r', fs.existsSync(victim), false]);

        for (const [label, actual, expected] of results) strictEqual(actual, expected, label);
    }),
});

Deno.test({
    name: 'fs maxpath: mkdir recursive reaches past MAX_PATH-12',
    ignore: !isWindows,
    fn: () => withTempDir('maxpath-mkdir', async (tmp) => {
        // The pre-fix ceiling here was 247, the lowest of any API.
        const target = pathOfLength(path.join(tmp, 'm'), 300);
        const ret = fs.mkdirSync(target, { recursive: true });
        const madeSync = fs.statSync(target).isDirectory();
        // Node returns the first directory CREATED, in NAMESPACED form, and
        // undefined when nothing had to be made (measured v24.18.0).
        const retIsNamespaced = String(ret).startsWith('\\\\?\\');
        const retOnExisting = fs.mkdirSync(target, { recursive: true });

        const atarget = pathOfLength(path.join(tmp, 'ma'), 300);
        const aret = await fsp.mkdir(atarget, { recursive: true });
        const madeAsync = fs.statSync(atarget).isDirectory();

        strictEqual(madeSync, true, 'sync recursive mkdir created the deep dir');
        strictEqual(madeAsync, true, 'async recursive mkdir created the deep dir');
        ok(retIsNamespaced, `mkdirSync recursive returns a namespaced path, got ${ret}`);
        ok(String(aret).startsWith('\\\\?\\'), `fsp.mkdir recursive returns namespaced, got ${aret}`);
        strictEqual(retOnExisting, undefined, 'recursive mkdir on an existing dir returns undefined');
    }),
});

Deno.test({
    name: 'fs maxpath: errors carry the ORIGINAL path, never the \\\\?\\ form',
    ignore: !isWindows,
    fn: () => withTempDir('maxpath-err', async (tmp) => {
        const dir = makeDeepDir(path.join(tmp, 'd'), 320);
        const missing = `${dir}\\nope`;
        const seen: Array<[string, string | undefined, string]> = [];

        const grab = (label: string, fn: () => unknown) => {
            try { fn(); seen.push([label, undefined, '']); } catch (e) {
                const err = e as NodeJS.ErrnoException;
                seen.push([label, err.path, err.message]);
            }
        };
        grab('statSync', () => fs.statSync(missing));
        grab('lstatSync', () => fs.lstatSync(missing));
        grab('readdirSync', () => fs.readdirSync(missing));
        grab('readFileSync', () => fs.readFileSync(missing));
        grab('rmSync', () => fs.rmSync(missing, { recursive: true }));
        try { await fsp.stat(missing); } catch (e) {
            const err = e as NodeJS.ErrnoException;
            seen.push(['fsp.stat', err.path, err.message]);
        }
        try { await fsp.readdir(missing); } catch (e) {
            const err = e as NodeJS.ErrnoException;
            seen.push(['fsp.readdir', err.path, err.message]);
        }

        for (const [label, p, message] of seen) {
            strictEqual(p, missing, `${label}: err.path must be the caller's path`);
            ok(!message.includes('\\\\?\\'), `${label}: message must not leak \\\\?\\ — got ${message}`);
            ok(message.includes(missing), `${label}: message must quote the original path`);
        }
    }),
});

Deno.test({
    name: 'fs maxpath: `..`, `.` and forward slashes still resolve at long lengths',
    ignore: !isWindows,
    fn: () => withTempDir('maxpath-norm', (tmp) => {
        const dir = makeDeepDir(path.join(tmp, 'd'), 300);
        const leaf = path.basename(dir);
        // 466 chars, and only reachable if `..` is collapsed BEFORE prefixing:
        // `\\?\` paths are handed to Win32 verbatim, so an unresolved `..`
        // would be treated as a literal directory name and fail.
        const viaDotDot = `${dir}\\..\\${leaf}`;
        const viaDot = `${dir}\\.`;
        const viaFwd = dir.replace(/\\/g, '/');
        const viaDouble = dir.replace(`\\${leaf}`, `\\\\${leaf}`);

        const r = {
            dotdotLen: viaDotDot.length,
            dotdotStat: fs.statSync(viaDotDot).isDirectory(),
            dotdotReaddir: fs.readdirSync(viaDotDot).join(),
            dotStat: fs.statSync(viaDot).isDirectory(),
            fwdStat: fs.statSync(viaFwd).isDirectory(),
            fwdReaddir: fs.readdirSync(viaFwd).join(),
            doubleStat: fs.statSync(viaDouble).isDirectory(),
            // realpath must hand back the canonical form, not the `..` spelling
            dotdotRealpath: fs.realpathSync(viaDotDot),
        };

        ok(r.dotdotLen > 260, `the .. path must exceed MAX_PATH, got ${r.dotdotLen}`);
        strictEqual(r.dotdotStat, true, 'statSync through ..');
        strictEqual(r.dotdotReaddir, 'c', 'readdirSync through ..');
        strictEqual(r.dotStat, true, 'statSync through .');
        strictEqual(r.fwdStat, true, 'statSync with forward slashes');
        strictEqual(r.fwdReaddir, 'c', 'readdirSync with forward slashes');
        strictEqual(r.doubleStat, true, 'statSync with a doubled separator');
        strictEqual(r.dotdotRealpath, dir, 'realpathSync canonicalises the .. path');
    }),
});

Deno.test({
    name: 'fs maxpath: path-walking helpers and the fswatch binding reach past MAX_PATH',
    ignore: !isWindows,
    fn: () => withTempDir('maxpath-walkers', async (tmp) => {
        // These are the entry points that build intermediate paths themselves
        // (mkdirRecursiveSync, removeRecursiveSync, readDirEntriesSync, copy)
        // plus `fs.watch`, which goes through a THIRD native binding (`fswatch`)
        // that an fs/asyncfs-only wrap leaves behind — it threw ENOENT on a
        // >259-char directory while Node watched it happily.
        const root = path.join(tmp, 'tree');
        let cur = root;
        fs.mkdirSync(cur, { recursive: true });
        for (let i = 0; i < 12; i++) {
            cur = `${cur}\\lvl${String(i).padStart(2, '0')}${'q'.repeat(28)}`;
            fs.mkdirSync(cur, { recursive: true });
            fs.writeFileSync(`${cur}\\f${i}.txt`, `L${i}`);
        }
        const deepest = cur;

        const r = {
            deepestLen: deepest.length,
            // mkdir{recursive} given an ALREADY-namespaced path: splitMkdirPath
            // rewrites separators, so `\\?\` must survive that rewrite.
            nsInput: (() => {
                const t = `\\\\?\\${path.join(tmp, 'nsin', 'a'.repeat(150), 'b'.repeat(120))}`;
                fs.mkdirSync(t, { recursive: true });
                return fs.statSync(t).isDirectory();
            })(),
            cpSync: (() => {
                fs.cpSync(root, path.join(tmp, 'copy2'), { recursive: true });
                return fs.readdirSync(path.join(tmp, 'copy2'), { recursive: true })
                    .filter((e) => String(e).endsWith('.txt')).length;
            })(),
            cpAsync: await (async () => {
                await fsp.cp(root, path.join(tmp, 'copy3'), { recursive: true });
                return (await fsp.readdir(path.join(tmp, 'copy3'), { recursive: true }))
                    .filter((e) => String(e).endsWith('.txt')).length;
            })(),
            glob: fs.globSync(`${root.replace(/\\/g, '/')}/**/*.txt`).length,
            watch: (() => {
                const w = fs.watch(deepest, () => {});
                w.close();
                return 'watched';
            })(),
            mkdtempIsPlain: (() => {
                // cno reaches further than Node here (Node throws ENOENT past
                // MAX_PATH in mkdtemp), but the path handed back must stay plain.
                const d = fs.mkdtempSync(`${deepest}\\t-`);
                return !d.startsWith('\\\\?\\') && fs.statSync(d).isDirectory();
            })(),
            linkDeep: (() => {
                fs.linkSync(`${deepest}\\f11.txt`, `${deepest}\\hard.txt`);
                return fs.readFileSync(`${deepest}\\hard.txt`, 'utf8');
            })(),
            truncateDeep: (() => {
                fs.truncateSync(`${deepest}\\hard.txt`, 1);
                return fs.statSync(`${deepest}\\hard.txt`).size;
            })(),
            // removeRecursiveSync walks and unlinks each entry itself.
            rmSync: (() => {
                fs.rmSync(path.join(tmp, 'copy2'), { recursive: true });
                return fs.existsSync(path.join(tmp, 'copy2'));
            })(),
            rmAsync: await (async () => {
                await fsp.rm(path.join(tmp, 'copy3'), { recursive: true });
                return fs.existsSync(path.join(tmp, 'copy3'));
            })(),
        };

        ok(r.deepestLen > 400, `deepest must exceed MAX_PATH, got ${r.deepestLen}`);
        strictEqual(r.nsInput, true, 'mkdir{recursive} on an already-namespaced input');
        strictEqual(r.cpSync, 12, `cpSync recursive copied ${r.cpSync}/12`);
        strictEqual(r.cpAsync, 12, `fsp.cp recursive copied ${r.cpAsync}/12`);
        strictEqual(r.glob, 12, `globSync found ${r.glob}/12`);
        strictEqual(r.watch, 'watched', 'fs.watch on a deep directory');
        strictEqual(r.mkdtempIsPlain, true, 'mkdtempSync deep returns a plain usable path');
        strictEqual(r.linkDeep, 'L11', 'linkSync on a deep path');
        strictEqual(r.truncateDeep, 1, 'truncateSync on a deep path');
        strictEqual(r.rmSync, false, 'rmSync{recursive} removed the deep tree');
        strictEqual(r.rmAsync, false, 'fsp.rm{recursive} removed the deep tree');
    }),
});

Deno.test({
    name: 'fs maxpath: a recursive walk of a deep plain tree completes',
    ignore: !isWindows,
    fn: () => withTempDir('maxpath-walk', async (tmp) => {
        // The reported symptom: a link-free recursive walk aborted with ENOENT
        // partway down. Chain plain 40-char segments past 260 total.
        const root = path.join(tmp, 'w');
        let cur = root;
        const expected: string[] = [];
        for (let i = 0; i < 12; i++) {
            cur = path.join(cur, `seg${String(i).padStart(2, '0')}${'x'.repeat(30)}`);
            expected.push(`f${i}.txt`);
        }
        fs.mkdirSync(cur, { recursive: true });
        // Drop one file at each level so a truncated walk is detectable.
        let lvl = root;
        for (let i = 0; i < 12; i++) {
            lvl = path.join(lvl, `seg${String(i).padStart(2, '0')}${'x'.repeat(30)}`);
            fs.writeFileSync(path.join(lvl, `f${i}.txt`), `L${i}`);
        }
        ok(cur.length > 400, `deepest dir must exceed MAX_PATH, got ${cur.length}`);

        const syncFiles = fs.readdirSync(root, { recursive: true })
            .map(String).filter((e) => e.endsWith('.txt')).sort();
        const asyncFiles = (await fsp.readdir(root, { recursive: true }))
            .map(String).filter((e) => e.endsWith('.txt')).sort();
        const opendirFiles: string[] = [];
        const dir = await fsp.opendir(root, { recursive: true });
        for await (const ent of dir) if (ent.name.endsWith('.txt')) opendirFiles.push(ent.name);

        // A silently-short walk is the failure mode this pins: assert the full
        // count, not merely "did not throw".
        strictEqual(syncFiles.length, 12, `readdirSync recursive found ${syncFiles.length}/12`);
        strictEqual(asyncFiles.length, 12, `fsp.readdir recursive found ${asyncFiles.length}/12`);
        strictEqual(opendirFiles.length, 12, `opendir recursive found ${opendirFiles.length}/12`);
        strictEqual(syncFiles.map((f) => path.basename(f)).sort().join(), expected.sort().join());
    }),
});
