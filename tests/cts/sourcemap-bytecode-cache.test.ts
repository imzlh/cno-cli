import { strictEqual } from 'node:assert';
import { CjsLoader, type CjsDeps } from '../../cts/src/compile/cjs.ts';
import { EsmCompiler } from '../../cts/src/compile/esm.ts';
import { createConfig } from '../../cts/src/config.ts';
import { ParseDriver } from '../../cts/src/parse.ts';
import { OxcTranspiler } from '../../cts/src/oxc.ts';
import type { SourceFreshness } from '../../cts/src/source/cache.ts';
import { joinPaths } from '../../cts/src/utils/path.ts';
import { withTempDir } from '../_helpers/temp.ts';

const engine = import.meta.use('engine');
const sourceMap = JSON.stringify({
    version: 3,
    sources: ['original.js'],
    names: [],
    mappings: 'AAAA',
});

function fakeOxc(output: string, withSourceMap = true): OxcTranspiler {
    return new OxcTranspiler({
        version: 'test',
        transpile() {
            return { code: output, sourceMap: withSourceMap ? sourceMap : undefined };
        },
        transpileBytes() {
            return {
                code: engine.encodeString(output),
                sourceMap: withSourceMap ? engine.encodeString(sourceMap) : undefined,
            };
        },
        scanImports() {
            return [];
        },
    });
}

Deno.test('cts esm sourcemap: transformed JS with a runtime map skips persistent bytecode', async () => {
    await withTempDir('cts-sourcemap-esm-bytecode', async (root) => {
        const localPath = joinPaths(root, 'decorated.js');
        await Deno.writeTextFile(localPath, '@decorate\nclass Example {}\nexport { Example };\n');
        const cfg = createConfig({
            cacheDir: joinPaths(root, 'cache'),
            enableCache: true,
            silent: true,
        });
        let transforms = 0;
        const load = () => {
            const compiler = new EsmCompiler(cfg);
            compiler.setOxc(fakeOxc('export class Example {}'));
            const original = compiler.transformer.transformBytes.bind(compiler.transformer);
            compiler.transformer.transformBytes = (...args) => {
                transforms++;
                return original(...args);
            };
            const info = { specPath: localPath, localPath, format: 'esm' as const, fileKind: 'source' as const };
            const mod = compiler.load(info);
            mod.resolve();
            engine.promiseResult(mod.eval());
        };

        load();
        load();
        strictEqual(transforms, 2, 'the second compiler must transform source instead of hitting bytecode');
    });
});

Deno.test('cts precache sourcemap: runtime-mapped bytecode is not persisted', async () => {
    await withTempDir('cts-sourcemap-precache', async (root) => {
        const typedPath = joinPaths(root, 'typed.ts');
        const decoratedPath = joinPaths(root, 'decorated.js');
        await Deno.writeTextFile(typedPath, 'export const value: number = 42;\n');
        await Deno.writeTextFile(decoratedPath, '@decorate\nclass Example {}\nexport { Example };\n');

        let persisted = 0;
        let runtimeMapped = 0;
        const inlineDriver = new ParseDriver(fakeOxc('export const value = 42;'), 0);
        const mainThreadDriver = new ParseDriver(fakeOxc('export class Example {}'), 1);
        try {
            await inlineDriver.precompile([{
                specPath: typedPath,
                localPath: typedPath,
                format: 'esm',
                lang: 'ts',
            }], undefined, (_localPath, _bytecode, _specPath, hasRuntimeSourceMap) => {
                if (hasRuntimeSourceMap) runtimeMapped++;
                else persisted++;
            });
            await mainThreadDriver.precompile([{
                specPath: decoratedPath,
                localPath: decoratedPath,
                format: 'esm',
            }], undefined, (_localPath, _bytecode, _specPath, hasRuntimeSourceMap) => {
                if (hasRuntimeSourceMap) runtimeMapped++;
                else persisted++;
            });
        } finally {
            await inlineDriver.terminate();
            await mainThreadDriver.terminate();
        }
        strictEqual(persisted, 0, 'runtime source maps must be registered again from source on later runs');
        strictEqual(runtimeMapped, 2, 'streaming callers receive mapped bytecode and can choose source fallback');
    });
});

Deno.test('cts esm sourcemap gate: transformed TypeScript without a runtime map remains cacheable', async () => {
    await withTempDir('cts-sourcemap-ts-bytecode', async (root) => {
        const localPath = joinPaths(root, 'typed.ts');
        await Deno.writeTextFile(localPath, 'export const value: number = 42;\n');
        const cfg = createConfig({
            cacheDir: joinPaths(root, 'cache'),
            enableCache: true,
            silent: true,
        });
        let transforms = 0;
        const load = () => {
            const compiler = new EsmCompiler(cfg);
            compiler.setOxc(fakeOxc('export const value = 42;', false));
            const original = compiler.transformer.transformBytes.bind(compiler.transformer);
            compiler.transformer.transformBytes = (...args) => {
                transforms++;
                return original(...args);
            };
            const info = { specPath: localPath, localPath, format: 'esm' as const, fileKind: 'source' as const };
            const mod = compiler.load(info);
            mod.resolve();
            engine.promiseResult(mod.eval());
            strictEqual(mod.namespace.value, 42);
        };

        load();
        load();
        strictEqual(transforms, 1, 'the second compiler should use valid persisted TypeScript bytecode');
    });
});

Deno.test('cts cjs sourcemap: transformed JS with a runtime map skips persistent bytecode', async () => {
    await withTempDir('cts-sourcemap-cjs-bytecode', async (root) => {
        const localPath = joinPaths(root, 'decorated.js');
        await Deno.writeTextFile(localPath, '@decorate\nclass Example {}\nmodule.exports = Example;\n');
        const freshness: SourceFreshness = { mtim: '1', size: 1, hash: 'source-hash' };
        let persists = 0;
        let transforms = 0;
        const makeLoader = () => {
            const compiler = new EsmCompiler(createConfig({
                cacheDir: joinPaths(root, 'cache'),
                enableCache: true,
                silent: true,
            }));
            compiler.setOxc(fakeOxc('class Example {}\nmodule.exports = Example;'));
            const prepare = compiler.transformer.transformForCjs.bind(compiler.transformer);
            const deps: CjsDeps = {
                resolveBuiltin() { throw new Error('unexpected builtin resolution'); },
                loadEsmSync() { throw new Error('unexpected ESM load'); },
                resolveExternal() { return null; },
                loadCjsCompiled() { return null; },
                captureSourceFreshness() { return freshness; },
                prepareSource(code, path) {
                    transforms++;
                    return prepare(code, path);
                },
                tookInlineSourceMap(path) {
                    return compiler.transformer.tookInlineSourceMap(path);
                },
                persistCjsCompiled() {
                    persists++;
                },
            };
            return new CjsLoader(deps);
        };

        makeLoader().loadAndGet(localPath);
        makeLoader().loadAndGet(localPath);
        strictEqual(transforms, 2, 'the second loader must transform source instead of hitting bytecode');
        strictEqual(persists, 0, 'runtime-mapped CJS must not persist bytecode');
    });
});
