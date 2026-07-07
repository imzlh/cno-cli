import { deepStrictEqual, strictEqual, throws } from 'node:assert';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { makePosixTempDir } from '../_helpers/temp.ts';
import { createConfig } from '../../cts/src/config.ts';
import { runSync } from '../../cts/src/flow.ts';
import { LockStore } from '../../cts/src/lock.ts';
import { ModuleResolver } from '../../cts/src/resolve/index.ts';
import { NodeHandler } from '../../cts/src/resolve/protocols/node.ts';
import { joinPaths } from '../../cts/src/utils/path.ts';

function writePolyfill(cacheDir: string, bare: string): string {
    const localPath = bare.includes('/')
        ? joinPaths(cacheDir, 'node', `${bare}.ts`)
        : joinPaths(cacheDir, 'node', bare, 'index.ts');
    mkdirSync(join(localPath, '..'), { recursive: true });
    writeFileSync(join(localPath), `export const id = ${JSON.stringify(bare)};\n`);
    return localPath;
}

Deno.test('cts node protocol: resolves bare and subpath polyfills from cache dir', () => {
    const root = makePosixTempDir('node-protocol');
    try {
        const cacheDir = joinPaths(root, 'cache');
        const fsPath = writePolyfill(cacheDir, 'fs');
        const streamWebPath = writePolyfill(cacheDir, 'stream/web');
        const handler = new NodeHandler(createConfig({ cacheDir }));

        deepStrictEqual(runSync(handler.resolve('node:fs', '/entry.ts')), {
            specPath: 'node:fs',
            localPath: fsPath,
            format: 'esm',
            fileKind: 'source',
        });
        deepStrictEqual(runSync(handler.resolve('node:stream/web', '/entry.ts')), {
            specPath: 'node:stream/web',
            localPath: streamWebPath,
            format: 'esm',
            fileKind: 'source',
        });
        strictEqual(handler.localPath('node:stream/web'), streamWebPath);
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
});

Deno.test('cts node protocol: relative polyfill imports stay inside builtin namespace', () => {
    const root = makePosixTempDir('node-protocol-relative');
    try {
        const cacheDir = joinPaths(root, 'cache');
        const internalPath = writePolyfill(cacheDir, 'stream/internal');
        const nestedPath = writePolyfill(cacheDir, 'stream/internal/foo');
        const handler = new NodeHandler(createConfig({ cacheDir }));

        deepStrictEqual(runSync(handler.resolve('./internal', 'node:stream/web')), {
            specPath: 'node:stream/internal',
            localPath: internalPath,
            format: 'esm',
            fileKind: 'source',
        });
        const nested = runSync(handler.resolve('./internal/foo', 'node:stream/web'));
        deepStrictEqual(nested, {
            specPath: 'node:stream/internal/foo',
            localPath: nestedPath,
            format: 'esm',
            fileKind: 'source',
        });
        strictEqual(handler.localPath(nested.specPath), nested.localPath);
        throws(() => runSync(handler.resolve('../../escape', 'node:stream/web')), /escapes module boundary/);
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
});

Deno.test('cts node protocol: registered resolver bypasses cache filesystem lookup', () => {
    const root = makePosixTempDir('node-protocol-external');
    try {
        const cacheDir = joinPaths(root, 'cache');
        const handler = new NodeHandler(createConfig({ cacheDir }));
        handler.registerResolver((bare) => bare === 'external' ? '/virtual/external.ts' : null);

        deepStrictEqual(runSync(handler.resolve('node:external', '/entry.ts')), {
            specPath: 'node:external',
            localPath: '/virtual/external.ts',
            format: 'esm',
            fileKind: 'source',
        });
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
});

Deno.test('cts node protocol: ignores stale lock paths from another cache dir', () => {
    const root = makePosixTempDir('node-protocol-lock');
    try {
        const oldCache = joinPaths(root, 'old-cache');
        const newCache = joinPaths(root, 'new-cache');
        const oldPath = writePolyfill(oldCache, 'fs/utils');
        const newPath = writePolyfill(newCache, 'fs/utils');

        const store = new LockStore(root, false);
        store.load();
        store.setModule({
            specPath: 'node:fs/utils',
            localPath: oldPath,
            format: 'esm',
            fileKind: 'source',
        });
        store.setSourceByKey('esm\0node:fs/utils\0/entry.ts\0', 'node:fs/utils');
        store.flush();
        store.close();

        const resolver = new ModuleResolver(createConfig({ cacheDir: newCache }), root, true);
        strictEqual(resolver.resolve('node:fs/utils', '/entry.ts').localPath, newPath);
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
});
