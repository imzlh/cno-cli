import { deepStrictEqual, rejects, strictEqual } from 'node:assert';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { createConfig } from '../../cts/src/config.ts';
import { ErrorKind } from '../../cts/src/errors.ts';
import { ModuleResolver } from '../../cts/src/resolve/index.ts';
import { moduleViewRef, type ModuleInfo } from '../../cts/src/types.ts';
import { canonicalizePath, joinPaths } from '../../cts/src/utils/path.ts';
import { makePosixTempDir } from '../_helpers/temp.ts';

for (const method of ['resolve', 'resolveAsync'] as const) {
    Deno.test(`cts ${method}: source lock wins over local packages and canonical lock entries`, async () => {
        const root = makePosixTempDir('resolver-source-cache');
        const resolver = new ModuleResolver(createConfig({
            cacheDir: joinPaths(root, 'cache'), disableLock: true, frozen: true, ignoreScripts: true,
        }), root);
        try {
            const pkgDir = joinPaths(root, 'node_modules', 'cache-fixture');
            mkdirSync(pkgDir, { recursive: true });
            writeFileSync(joinPaths(pkgDir, 'package.json'), JSON.stringify({
                name: 'cache-fixture', version: '1.0.0', main: 'index.cjs',
            }));
            writeFileSync(joinPaths(pkgDir, 'index.cjs'), 'module.exports = "local";');
            const request = 'npm:cache-fixture@1.0.0';
            const parent = canonicalizePath(joinPaths(root, 'entry.ts'));
            const locked: ModuleInfo = {
                specPath: `${request}/locked.js`,
                localPath: joinPaths(root, 'old-cache', 'missing.cjs'),
                format: 'esm',
                fileKind: 'source',
            };
            resolver.lockStore.setModule(locked);
            resolver.lockStore.setModule({ ...locked, specPath: request, localPath: 'wrong-canonical-hit.js' });
            resolver.lockStore.setSourceByKey(`esm\0${request}\0${parent}\0`, locked.specPath);
            const info = await resolver[method](request, parent);
            deepStrictEqual(info, locked);

            resolver.lockStore.setModule({ ...locked, localPath: 'new-lock-path.js' });
            strictEqual(await resolver[method](request, parent), info);
            // Empty attributes bypass the exact cache, but share the source cache.
            strictEqual(await resolver[method](request, parent, {}), info);
        } finally {
            resolver.close();
            rmSync(root, { recursive: true, force: true });
        }
    });

    Deno.test(`cts ${method}: canonical lock hits retain views and frozen misses still fail`, async () => {
        const root = makePosixTempDir('resolver-canonical-cache');
        const resolver = new ModuleResolver(createConfig({
            cacheDir: joinPaths(root, 'cache'), disableLock: true, frozen: true, ignoreScripts: true,
        }), root);
        try {
            const parent = joinPaths(root, 'entry.ts');
            const locked: ModuleInfo = {
                specPath: 'data:text/javascript,export%20default%201',
                localPath: joinPaths(root, 'missing.cjs'),
                format: 'esm',
                fileKind: 'source',
            };
            resolver.lockStore.setModule(locked);
            const info = await resolver[method](locked.specPath, parent);
            deepStrictEqual(info, locked);
            const text = await resolver[method](locked.specPath, parent, { type: 'text' });
            deepStrictEqual(text, {
                ...locked, fileKind: 'text', moduleId: moduleViewRef(locked.specPath, 'text'), cacheBytecode: false,
            });
            strictEqual(await resolver[method](locked.specPath, parent), info);
            await rejects(async () => resolver[method](locked.specPath, parent, { type: 'json' }), {
                code: 'ERR_IMPORT_ATTRIBUTE_TYPE_INCOMPATIBLE',
            });
            await rejects(async () => resolver[method]('data:text/javascript,missing', parent), {
                kind: ErrorKind.LockFrozen,
            });
        } finally {
            resolver.close();
            rmSync(root, { recursive: true, force: true });
        }
    });
}
