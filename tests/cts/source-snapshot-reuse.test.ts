import { deepStrictEqual, strictEqual } from 'node:assert';
import { CjsLoader, type CjsDeps } from '../../cts/src/compile/cjs.ts';
import { EsmCompiler } from '../../cts/src/compile/esm.ts';
import { createConfig } from '../../cts/src/config.ts';
import type { SourceFreshness, SourceSnapshot } from '../../cts/src/source/cache.ts';
import type { ModuleInfo } from '../../cts/src/types.ts';
import { joinPaths } from '../../cts/src/utils/path.ts';
import { withTempDir } from '../_helpers/temp.ts';

const engine = import.meta.use('engine');
const unused = (): never => { throw new Error('unexpected dependency call'); };

function snapshot(code: string): SourceSnapshot {
    const bytes = engine.encodeString(code);
    return {
        bytes,
        freshness: { mtim: '1', size: bytes.byteLength, hash: 'source-hash' },
    };
}

Deno.test('cts cjs compiler: cache miss consumes source snapshot without rereading', () => {
    const source = snapshot('module.exports = { answer: 42 };');
    let takeCalls = 0;
    let captureCalls = 0;
    let persisted: SourceFreshness | undefined;
    const deps: CjsDeps = {
        resolveBuiltin: unused,
        loadEsmSync: unused,
        resolveExternal: () => null,
        loadCjsCompiled: () => null,
        takeSourceSnapshot() {
            takeCalls++;
            return source;
        },
        captureSourceFreshness() {
            captureCalls++;
            return undefined;
        },
        persistCjsCompiled(_path, _bytes, freshness) {
            persisted = freshness;
        },
    };

    // The path deliberately does not exist. Success proves the fresh compile
    // used the bytes retained by the cache miss instead of opening the file.
    const mod = new CjsLoader(deps).loadAndGet('/virtual/source-snapshot.cjs');
    deepStrictEqual(mod.exports, { answer: 42 });
    strictEqual(takeCalls, 1);
    strictEqual(captureCalls, 0);
    strictEqual(persisted, source.freshness);
});

Deno.test('cts esm compiler: cache miss compiles and persists the same source snapshot', async () => {
    await withTempDir('cts-esm-source-snapshot', (root) => {
        const localPath = joinPaths(root, 'missing', 'source-snapshot.js');
        const source = snapshot('export const answer = 42;');
        const compiler = new EsmCompiler(createConfig({
            cacheDir: joinPaths(root, 'cache'),
            enableCache: true,
            silent: true,
        }));
        let takeCalls = 0;
        let persisted: SourceFreshness | undefined;

        Reflect.set(compiler.jsc, 'load', () => null);
        Reflect.set(compiler.jsc, 'takeSourceSnapshot', () => {
            takeCalls++;
            return source;
        });
        Reflect.set(compiler.jsc, 'persistLocal', (
            _path: string,
            _mod: CModuleEngine.Module,
            _moduleId?: string,
            freshness?: SourceFreshness,
        ) => {
            persisted = freshness;
        });

        const info: ModuleInfo = {
            specPath: localPath,
            localPath,
            format: 'esm',
            fileKind: 'source',
        };
        const mod = compiler.load(info);
        mod.resolve();
        engine.promiseResult(mod.eval());
        strictEqual(mod.namespace.answer, 42);
        strictEqual(takeCalls, 1);
        strictEqual(persisted, source.freshness);
    });
});
