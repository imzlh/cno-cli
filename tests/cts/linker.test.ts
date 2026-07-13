import { deepStrictEqual, ok, rejects, strictEqual } from 'node:assert';
import {
    existsSync,
    lstatSync,
    mkdirSync,
    readFileSync,
    readlinkSync,
    rmSync,
    writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { makePosixTempDir } from '../_helpers/temp.ts';
import { materializeNodeModules } from '../../cts/src/resolve/linker.ts';
import type { ScanResult } from '../../cts/src/deps.ts';
import { joinPaths } from '../../cts/src/utils/path.ts';

type Edge = ScanResult['edges'][number];

function seedPkg(cacheDir: string, name: string, version: string, files: Record<string, string> = {}): string {
    const dir = joinPaths(cacheDir, 'npm', `${name}@${version}`);
    mkdirSync(join(dir), { recursive: true });
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ name, version }));
    for (const [rel, text] of Object.entries(files)) {
        const path = joinPaths(dir, rel);
        mkdirSync(join(path, '..'), { recursive: true });
        writeFileSync(join(path), text);
    }
    return dir;
}

function edge(parentSpecPath: string, name: string, childSpecPath: string, childLocalPath: string): Edge {
    return { parentSpecPath, name, childSpecPath, childLocalPath };
}

Deno.test('cts linker: soft mode symlinks project roots and nested store edges', async () => {
    const root = makePosixTempDir('linker-soft');
    try {
        const cacheDir = joinPaths(root, 'cache');
        const projectDir = joinPaths(root, 'project');
        const alphaDir = seedPkg(cacheDir, 'alpha', '1.0.0', { 'index.js': 'export const alpha = 1;\n' });
        const betaDir = seedPkg(cacheDir, 'beta', '2.0.0', { 'index.js': 'export const beta = 2;\n' });
        mkdirSync(join(projectDir), { recursive: true });

        const progress: Array<[number, number]> = [];
        await materializeNodeModules([
            edge(`${projectDir}/<cache>`, 'alpha', 'npm:alpha@1.0.0/index.js', joinPaths(alphaDir, 'index.js')),
            edge('npm:alpha@1.0.0/index.js', 'beta', 'npm:beta@2.0.0/index.js', joinPaths(betaDir, 'index.js')),
        ], 'soft', cacheDir, projectDir, (done, total) => {
            progress.push([done, total]);
        });

        const linked = joinPaths(projectDir, 'node_modules', 'alpha');
        ok(lstatSync(join(linked)).isSymbolicLink());
        strictEqual(readlinkSync(join(linked)), alphaDir);
        // Nested edges land under the store package (Node walks realpath).
        const nested = join(alphaDir, 'node_modules', 'beta');
        ok(lstatSync(nested).isSymbolicLink());
        strictEqual(readlinkSync(nested), betaDir);
        deepStrictEqual(JSON.parse(readFileSync(join(projectDir, 'node_modules', '.cts-node-modules.json'), 'utf8')), ['alpha']);
        deepStrictEqual(progress, [[0, 2], [1, 2], [2, 2]]);
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
});

Deno.test('cts linker: hard mode materializes nested edges; prunes project roots only', async () => {
    const root = makePosixTempDir('linker-hard');
    try {
        const cacheDir = joinPaths(root, 'cache');
        const projectDir = joinPaths(root, 'project');
        const alphaDir = seedPkg(cacheDir, 'alpha', '1.0.0', { 'index.js': 'export const alpha = 1;\n' });
        const betaDir = seedPkg(cacheDir, 'beta', '2.0.0', { 'index.js': 'export const beta = 2;\n' });
        seedPkg(cacheDir, 'old', '9.0.0');
        mkdirSync(join(projectDir, 'node_modules', 'old'), { recursive: true });
        writeFileSync(join(projectDir, 'node_modules', 'old', 'stale.txt'), 'stale\n');
        writeFileSync(join(projectDir, 'node_modules', '.cts-node-modules.json'), JSON.stringify(['old']));
        // Install-owned nested link must survive materialize (not wiped).
        mkdirSync(join(alphaDir, 'node_modules', 'install-peer'), { recursive: true });
        writeFileSync(join(alphaDir, 'node_modules', 'install-peer', 'package.json'), '{"name":"install-peer"}');

        await materializeNodeModules([
            edge(`${projectDir}/<entry>`, 'alpha', 'npm:alpha@1.0.0/index.js', joinPaths(alphaDir, 'index.js')),
            edge('npm:alpha@1.0.0/index.js', 'beta', 'npm:beta@2.0.0/index.js', joinPaths(betaDir, 'index.js')),
            edge('npm:alpha@1.0.0/index.js', 'alpha', 'npm:alpha@1.0.0/index.js', joinPaths(alphaDir, 'index.js')),
        ], 'hard', cacheDir, projectDir);

        ok(existsSync(join(projectDir, 'node_modules', 'alpha', 'package.json')));
        strictEqual(readFileSync(join(projectDir, 'node_modules', 'alpha', 'index.js'), 'utf8'), 'export const alpha = 1;\n');
        ok(existsSync(join(alphaDir, 'node_modules', 'beta', 'package.json')));
        strictEqual(readFileSync(join(alphaDir, 'node_modules', 'beta', 'index.js'), 'utf8'), 'export const beta = 2;\n');
        ok(!existsSync(join(projectDir, 'node_modules', 'old')));
        ok(existsSync(join(alphaDir, 'node_modules', 'install-peer', 'package.json')));
        ok(!existsSync(join(alphaDir, 'node_modules', 'alpha')));
        deepStrictEqual(JSON.parse(readFileSync(join(projectDir, 'node_modules', '.cts-node-modules.json'), 'utf8')), ['alpha']);
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
});

Deno.test('cts linker: soft mode fails closed when store package is missing', async () => {
    const root = makePosixTempDir('linker-fail-closed');
    try {
        const cacheDir = joinPaths(root, 'cache');
        const projectDir = joinPaths(root, 'project');
        mkdirSync(join(projectDir), { recursive: true });
        // Edge points at npm:ghost@1.0.0 but nothing was extracted into the store.
        await rejects(
            () => materializeNodeModules([
                edge(`${projectDir}/<cache>`, 'ghost', 'npm:ghost@1.0.0/index.js', joinPaths(cacheDir, 'npm', 'ghost@1.0.0', 'index.js')),
            ], 'soft', cacheDir, projectDir),
            (e: unknown) => {
                ok(e instanceof Error);
                ok(/node_modules materialization failed/.test(e.message));
                ok(/failed to link ghost/.test(e.message));
                return true;
            },
        );
        ok(!existsSync(join(projectDir, 'node_modules', 'ghost')));
        ok(!existsSync(join(projectDir, 'node_modules', '.cts-node-modules.json')));
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
});
