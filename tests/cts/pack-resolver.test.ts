import { strictEqual, rejects, throws } from 'node:assert';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createConfig } from '../../cts/src/config.ts';
import { ErrorKind } from '../../cts/src/errors.ts';
import type { PackManifest, PackModuleEntry } from '../../cts/src/pack/format.ts';
import { PackHandler } from '../../cts/src/resolve/protocols/pack.ts';
import { ModuleResolver } from '../../cts/src/resolve/index.ts';
import { makePosixTempDir } from '../_helpers/temp.ts';

function source(localPath: string): PackModuleEntry {
    return { localPath, format: 'esm', fileKind: 'source', offset: 0, length: 0, sourceOffset: 0, sourceLength: 0 };
}

Deno.test('pack resolver: manifest edges precede import maps and external protocols', async () => {
    const root = makePosixTempDir('pack-resolver-authority');
    try {
        const cacheDir = join(root, 'cache');
        mkdirSync(cacheDir, { recursive: true });
        const entryPath = join(root, 'entry.ts');
        const barePath = join(root, 'bare.js');
        const directPath = join(root, 'direct.js');
        writeFileSync(entryPath, '');
        writeFileSync(barePath, '');
        writeFileSync(directPath, '');

        const entry = 'pack:/entry.ts';
        const bare = 'pack:npm/inside@1.0.0/index.js';
        const direct = 'pack:npm/direct@1.0.0/index.js';
        const manifest: PackManifest = {
            entry,
            modules: {
                [entry]: source(entryPath),
                [bare]: source(barePath),
                [direct]: source(directPath),
            },
            edges: {
                [entry]: {
                    inside: bare,
                    'npm:direct@1.0.0/index.js': direct,
                },
            },
            bytecodeVersion: 'test',
        };
        const resolver = new ModuleResolver(createConfig({
            cacheDir,
            cachedOnly: true,
            silent: true,
            importMap: { inside: 'npm:escape@9.9.9/index.js' },
        }), root, true);
        resolver.registerPackHandler(new PackHandler(manifest));

        strictEqual(resolver.resolve('inside', entry).specPath, bare);
        strictEqual((await resolver.resolveAsync('inside', entry)).specPath, bare);
        strictEqual(resolver.resolve('npm:direct@1.0.0/index.js', entry).specPath, direct);
        strictEqual((await resolver.resolveAsync('npm:direct@1.0.0/index.js', entry)).specPath, direct);

        throws(
            () => resolver.resolve('not-packed', entry),
            (e: unknown) => e instanceof Error && e.kind === ErrorKind.ModuleNotFound,
        );
        await rejects(
            () => resolver.resolveAsync('npm:not-packed@1.0.0/index.js', entry),
            (e: unknown) => e instanceof Error && e.kind === ErrorKind.ModuleNotFound,
        );
        resolver.lockStore.close();
    } finally {
        Deno.removeSync(root, { recursive: true });
    }
});
