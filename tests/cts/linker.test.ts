import { deepStrictEqual, ok, strictEqual } from 'node:assert';
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

Deno.test('cts linker: soft mode links only project root packages and writes manifest', async () => {
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
        ok(!existsSync(join(alphaDir, 'node_modules', 'beta')));
        deepStrictEqual(JSON.parse(readFileSync(join(projectDir, 'node_modules', '.cts-node-modules.json'), 'utf8')), ['alpha']);
        deepStrictEqual(progress, [[0, 1], [1, 1]]);
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
});

Deno.test('cts linker: hard mode materializes nested package edges and prunes stale roots', async () => {
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
        mkdirSync(join(alphaDir, 'node_modules', 'stale'), { recursive: true });
        writeFileSync(join(alphaDir, 'node_modules', 'stale', 'old.txt'), 'stale\n');

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
        ok(!existsSync(join(alphaDir, 'node_modules', 'stale')));
        ok(!existsSync(join(alphaDir, 'node_modules', 'alpha')));
        deepStrictEqual(JSON.parse(readFileSync(join(projectDir, 'node_modules', '.cts-node-modules.json'), 'utf8')), ['alpha']);
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
});
