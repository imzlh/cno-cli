/**
 * github:owner/repo[#ref] must install via codeload (not registry version match).
 * Repro: @marktext/file-icons depends on file-icons@github:file-icons/atom.
 */
import { ok, strictEqual } from 'node:assert';
import { existsSync, mkdirSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { makePosixTempDir } from '../_helpers/temp.ts';

const CNO = Deno.env.get('CNO') ?? Deno.execPath().replace(/ \(deleted\)$/, '');
const proc = import.meta.use('process');
const os = import.meta.use('os');

async function runCno(args: string[], cwd: string, env: Record<string, string> = {}): Promise<{ code: number; out: string }> {
    const child = proc.spawn([CNO, ...args], {
        cwd,
        env: { ...os.environ(), ...env },
        stdout: 'pipe',
        stderr: 'pipe',
    });
    const info = await child.wait();
    const out = [
        child.stdout ? new TextDecoder().decode(await child.stdout.arrayBuffer?.() ?? new Uint8Array()) : '',
    ].join('');
    // circu may expose differently — fall back to collecting via files if needed
    return { code: info.exit_status ?? 1, out };
}

Deno.test('npm github: range installs via codeload for cache hard', async () => {
    const root = makePosixTempDir('npm-github');
    const project = join(root, 'proj');
    const cache = join(root, 'cache');
    mkdirSync(project, { recursive: true });
    writeFileSync(join(project, 'package.json'), JSON.stringify({
        name: 'github-repro',
        version: '1.0.0',
        dependencies: {
            // Minimal package that only pulls github:file-icons/atom
            '@marktext/file-icons': '1.0.6',
        },
    }));

    // Reuse the running binary (repo convention: Deno.execPath, stripping the
    // " (deleted)" suffix Linux appends for a park-and-swapped exe). The old
    // hardcoded '/home/iz/cno-cli/build/stage/cno' made this fail with a bogus
    // ENOENT at native spawn on every machine but the original author's.
    const cno = CNO;
    const p = import.meta.use('process');
    const child = p.spawn([cno, 'cache', '--npm-mode=hard', `--cache-dir=${cache}`], {
        cwd: project,
        env: { ...os.environ(), CTS_CACHE_DIR: cache },
        stdout: 'inherit',
        stderr: 'inherit',
    });
    const info = await child.wait();
    strictEqual(info.exit_status ?? 1, 0, 'cno cache --npm-mode=hard should succeed with github: deps');

    ok(existsSync(join(project, 'node_modules', '@marktext', 'file-icons', 'package.json')));
    // file-icons must land under marktext's node_modules or top-level store link
    const nested = join(cache, 'npm', '@marktext', 'file-icons@1.0.6', 'node_modules', 'file-icons', 'package.json');
    // store path is name@version under npm/
    const storeNested = join(cache, 'npm', `@marktext/file-icons@1.0.6`, 'node_modules', 'file-icons', 'package.json');
    ok(existsSync(storeNested) || existsSync(nested), `file-icons linked under marktext: tried ${storeNested}`);
    const pkg = JSON.parse(readFileSync(storeNested, 'utf8'));
    strictEqual(pkg.name, 'file-icons');
    ok(typeof pkg.version === 'string' && pkg.version.length > 0);

    rmSync(root, { recursive: true, force: true });
});
