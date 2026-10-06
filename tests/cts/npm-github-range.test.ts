/**
 * github:owner/repo[#ref] must install via codeload (not registry version match).
 * Repro: @marktext/file-icons depends on file-icons@github:file-icons/atom.
 */
import { ok, strictEqual } from 'node:assert';
import { existsSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { withTempDir } from '../_helpers/temp.ts';

const CNO = Deno.env.get('CNO') ?? Deno.execPath().replace(/ \(deleted\)$/, '');
const proc = import.meta.use('process');
const os = import.meta.use('os');

async function runCno(args: string[], cwd: string, cache: string): Promise<number> {
    const child = proc.spawn([CNO, ...args], {
        cwd,
        env: { ...os.environ(), CTS_CACHE_DIR: cache },
        stdout: 'inherit',
        stderr: 'inherit',
    });
    return (await child.wait()).exit_status;
}

Deno.test('npm github: range installs via codeload for cache hard', () => withTempDir('npm-github', async root => {
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

    // Seed this private cache from the checkout before resolving from the temp project.
    const repo = fileURLToPath(new URL('../../', import.meta.url));
    strictEqual(await runCno(['setup', `--cache-dir=${cache}`], repo, cache), 0, 'local node setup');
    strictEqual(await runCno(['cache', '--npm-mode=hard', `--cache-dir=${cache}`], project, cache),
        0, 'cno cache --npm-mode=hard should succeed with github: deps');

    ok(existsSync(join(project, 'node_modules', '@marktext', 'file-icons', 'package.json')));
    const storeNested = join(cache, 'npm', `@marktext/file-icons@1.0.6`, 'node_modules', 'file-icons', 'package.json');
    ok(existsSync(storeNested), `file-icons linked under marktext: tried ${storeNested}`);
    const pkg = JSON.parse(readFileSync(storeNested, 'utf8'));
    strictEqual(pkg.name, 'file-icons');
    ok(typeof pkg.version === 'string' && pkg.version.length > 0);
}));
