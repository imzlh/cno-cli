import { strictEqual, throws } from 'node:assert';
import { join } from 'node:path';
import { LinkError, WasmCompiler } from '../../cts/src/compile/wasm.ts';
import type { ModuleInfo } from '../../cts/src/types.ts';
import { withTempDir } from '../_helpers/temp.ts';

const engine = import.meta.use('engine');

const WASM_GLUE_IMPORT = Uint8Array.from([
    0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00, 0x01, 0x09, 0x02, 0x60, 0x00, 0x01, 0x7f, 0x60,
    0x00, 0x01, 0x7f, 0x02, 0x14, 0x01, 0x09, 0x2e, 0x2f, 0x67, 0x6c, 0x75, 0x65, 0x2e, 0x6a, 0x73,
    0x06, 0x61, 0x6e, 0x73, 0x77, 0x65, 0x72, 0x00, 0x00, 0x03, 0x02, 0x01, 0x01, 0x07, 0x07, 0x01,
    0x03, 0x72, 0x75, 0x6e, 0x00, 0x01, 0x0a, 0x06, 0x01, 0x04, 0x00, 0x10, 0x00, 0x0b,
]);

function moduleInfo(specPath: string, localPath: string, fileKind: 'source' | 'wasm'): ModuleInfo {
    return { specPath, localPath, fileKind, format: 'esm' };
}

Deno.test('cts wasm: failed circular load clears pending state and retries cleanly', async () => {
    await withTempDir('wasm-cycle-retry', (root) => {
        const wasmPath = join(root, 'mod.wasm');
        const gluePath = join(root, 'glue.js');
        Deno.writeFileSync(wasmPath, WASM_GLUE_IMPORT);

        const wasmInfo = moduleInfo(wasmPath, wasmPath, 'wasm');
        const glueInfo = moduleInfo(gluePath, gluePath, 'source');
        const compiler = new WasmCompiler();
        let createCycle = true;

        const resolve = () => glueInfo;
        function loadModule(): CModuleEngine.Module {
            if (createCycle) return compiler.load(wasmInfo, resolve, loadModule);
            return new engine.Module('export function answer() { return 42; }', gluePath);
        }

        throws(() => compiler.load(wasmInfo, resolve, loadModule), LinkError);
        strictEqual(compiler.hasPendingLoads(), false);

        createCycle = false;
        const loaded = compiler.load(wasmInfo, resolve, loadModule);
        engine.promiseResult(loaded.eval());
        strictEqual(loaded.namespace.run(), 42);
    });
});

Deno.test('cts wasm: named exports remain linkable through a JavaScript cycle', async () => {
    await withTempDir('wasm-named-cycle', (root) => {
        const wasmPath = join(root, 'mod.wasm');
        const gluePath = join(root, 'glue.js');
        Deno.writeFileSync(wasmPath, WASM_GLUE_IMPORT);

        const wasmInfo = moduleInfo(wasmPath, wasmPath, 'wasm');
        const glueInfo = moduleInfo(gluePath, gluePath, 'source');
        const compiler = new WasmCompiler();

        const resolve = (spec: string) => spec === './mod.wasm' ? wasmInfo : glueInfo;
        function loadModule(info: ModuleInfo): CModuleEngine.Module {
            if (info.fileKind === 'wasm') return compiler.load(info, resolve, loadModule);
            return new engine.Module(
                'import { run } from "./mod.wasm"; export function answer() { return typeof run === "function" ? 42 : 0; }',
                gluePath,
            );
        }

        engine.onModule({
            resolve: (spec) => resolve(spec).specPath,
            load: (specPath) => loadModule(specPath === wasmInfo.specPath ? wasmInfo : glueInfo),
        });
        try {
            const loaded = compiler.load(wasmInfo, resolve, loadModule);
            engine.promiseResult(loaded.eval());

            strictEqual(loaded.namespace.run(), 42);
            strictEqual(compiler.hasPendingLoads(), false);
        } finally {
            engine.onModule({});
        }
    });
});

Deno.test('cts wasm: rejects async ESM dependencies without caching a partial module', async () => {
    await withTempDir('wasm-async-dependency', (root) => {
        const wasmPath = join(root, 'mod.wasm');
        const gluePath = join(root, 'glue.js');
        Deno.writeFileSync(wasmPath, WASM_GLUE_IMPORT);

        const wasmInfo = moduleInfo(wasmPath, wasmPath, 'wasm');
        const glueInfo = moduleInfo(gluePath, gluePath, 'source');
        const compiler = new WasmCompiler();
        let asyncDependency = true;

        const resolve = () => glueInfo;
        const loadModule = () => new engine.Module(
            asyncDependency
                ? 'export function answer() { return 1; } await Promise.resolve();'
                : 'export function answer() { return 42; }',
            `${gluePath}?${asyncDependency ? 'async' : 'sync'}`,
        );

        throws(() => compiler.load(wasmInfo, resolve, loadModule), LinkError);
        strictEqual(compiler.hasPendingLoads(), false);

        asyncDependency = false;
        const loaded = compiler.load(wasmInfo, resolve, loadModule);
        engine.promiseResult(loaded.eval());
        strictEqual(loaded.namespace.run(), 42);
    });
});
