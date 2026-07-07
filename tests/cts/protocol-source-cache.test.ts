import { deepStrictEqual, ok, strictEqual, throws } from 'node:assert';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createConfig } from '../../cts/src/config.ts';
import { runSync, StepType, type Flow, type Step } from '../../cts/src/flow.ts';
import { DataHandler } from '../../cts/src/resolve/protocols/data.ts';
import { FileHandler } from '../../cts/src/resolve/protocols/file.ts';
import { HttpHandler } from '../../cts/src/resolve/protocols/http.ts';
import { JscCache } from '../../cts/src/source/cache.ts';
import { joinPaths } from '../../cts/src/utils/path.ts';
import { withTempDir } from '../_helpers/temp.ts';

const engine = import.meta.use('engine');

function drive<T>(flow: Flow<T>, handler: (step: Step) => unknown): T {
    let state = flow.next();
    while (!state.done) {
        state = flow.next(handler(state.value as Step));
    }
    return state.value;
}

Deno.test('cts data protocol: writes decoded text, base64 and typed cache entries', async () => {
    await withTempDir('cts-data-protocol', (root) => {
        const cacheDir = joinPaths(root, 'cache');
        const handler = new DataHandler(createConfig({ cacheDir }));
        const textSpec = 'data:application/typescript,export%20const%20value%3A%20number%20%3D%201%3B';
        const jsonSpec = 'data:application/json;base64,eyJvayI6dHJ1ZX0=';

        const textInfo = runSync(handler.resolve(textSpec, '/entry.ts'));
        strictEqual(textInfo.specPath, textSpec);
        strictEqual(textInfo.format, 'esm');
        strictEqual(textInfo.fileKind, 'source');
        ok(textInfo.localPath.startsWith(joinPaths(cacheDir, 'data')));
        ok(textInfo.localPath.endsWith('.ts'));
        strictEqual(readFileSync(textInfo.localPath, 'utf8'), 'export const value: number = 1;');
        strictEqual(handler.localPath(textSpec), textInfo.localPath);

        const again = runSync(handler.resolve(textSpec, '/entry.ts'));
        strictEqual(again.localPath, textInfo.localPath);

        const jsonInfo = runSync(handler.resolve(jsonSpec, '/entry.ts'));
        strictEqual(jsonInfo.fileKind, 'json');
        strictEqual(readFileSync(jsonInfo.localPath, 'utf8'), '{"ok":true}');

        handler.clearCache();
        strictEqual(handler.localPath(textSpec), textInfo.localPath);
    });
});

Deno.test('cts data protocol: invalid data URLs fail before writing cache files', async () => {
    await withTempDir('cts-data-invalid', (root) => {
        const cacheDir = joinPaths(root, 'cache');
        const handler = new DataHandler(createConfig({ cacheDir }));

        throws(() => runSync(handler.resolve('data:text/plain,hello%ZZ', '/entry.ts')), /URL decode failed/);
        throws(() => handler.localPath('data:text/plain'), /Invalid data URL/);
    });
});

Deno.test('cts file protocol: resolves encoded file URLs and detects format/kind', async () => {
    await withTempDir('cts-file-protocol', (root) => {
        const handler = new FileHandler(createConfig({ cacheDir: joinPaths(root, 'cache') }));
        const modPath = join(root, 'spaced file.cts').replaceAll('\\', '/');
        mkdirSync(root, { recursive: true });
        writeFileSync(modPath, 'module.exports = 1;\n');

        const url = `file://${modPath.replace('spaced file', 'spaced%20file')}`;
        deepStrictEqual(runSync(handler.resolve(url, '/entry.ts')), {
            specPath: url,
            localPath: modPath,
            format: 'cjs',
            fileKind: 'source',
        });
        strictEqual(handler.localPath(url), modPath);
        throws(() => runSync(handler.resolve(`file://${join(root, 'missing.ts')}`, '/entry.ts')), /File not found/);
    });
});

Deno.test('cts http protocol: normalizes relative URLs and caches successful fetch bytes', async () => {
    await withTempDir('cts-http-protocol', (root) => {
        const cacheDir = joinPaths(root, 'cache');
        const handler = new HttpHandler(createConfig({ cacheDir, requestTimeout: 1234, silent: true }));
        const steps: Step[] = [];

        const info = drive(handler.resolve('./dep.ts', 'https://example.test/pkg/main.ts'), (step) => {
            steps.push(step);
            if (step.type === StepType.FS_EXISTS) return false;
            if (step.type === StepType.NET_FETCH) {
                strictEqual(step.url, 'https://example.test/pkg/dep.ts');
                strictEqual(step.timeout, 1234);
                return {
                    status: 200,
                    headers: [['content-type', 'application/typescript']],
                    body: engine.encodeString('export const dep = 1;\n'),
                };
            }
            if (step.type === StepType.FS_ENSURE_DIR) {
                mkdirSync(step.path, { recursive: true });
                return undefined;
            }
            if (step.type === StepType.FS_WRITE_BYTES) {
                mkdirSync(join(step.path, '..'), { recursive: true });
                writeFileSync(step.path, step.data as Uint8Array);
                return undefined;
            }
            throw new Error(`unexpected step ${step.type}`);
        });

        strictEqual(info.specPath, 'https://example.test/pkg/dep.ts');
        strictEqual(info.format, 'esm');
        strictEqual(info.fileKind, 'source');
        strictEqual(readFileSync(info.localPath, 'utf8'), 'export const dep = 1;\n');
        strictEqual(handler.localPath(info.specPath), info.localPath);
        strictEqual(steps.filter((step) => step.type === StepType.NET_FETCH).length, 1);

        const cached = drive(handler.resolve(info.specPath, 'https://example.test/pkg/main.ts'), (step) => {
            throw new Error(`cached resolve should not request step ${step.type}`);
        });
        strictEqual(cached.localPath, info.localPath);
    });
});

Deno.test('cts http protocol: non-2xx responses throw module not found errors', async () => {
    await withTempDir('cts-http-protocol-error', (root) => {
        const handler = new HttpHandler(createConfig({ cacheDir: joinPaths(root, 'cache'), silent: true }));
        throws(() => drive(handler.resolve('https://example.test/missing.ts', '/entry.ts'), (step) => {
            if (step.type === StepType.FS_EXISTS) return false;
            if (step.type === StepType.NET_FETCH) return { status: 404, headers: [], body: new Uint8Array(0) };
            throw new Error(`unexpected step ${step.type}`);
        }), /HTTP 404 fetching https:\/\/example\.test\/missing\.ts/);
    });
});

Deno.test('cts jsc cache: local freshness and remote sidecar paths are observable', async () => {
    await withTempDir('cts-jsc-cache', (root) => {
        const cacheDir = joinPaths(root, 'cache');
        const localPath = join(root, 'entry.ts').replaceAll('\\', '/');
        writeFileSync(localPath, 'export const value = 1;\n');

        const cache = new JscCache(cacheDir);
        const mod = new engine.Module('export const value = 1;', localPath);
        mod.resolve();
        cache.persistLocal(localPath, mod);
        strictEqual(cache.hasFresh(localPath, false), true);
        ok(cache.load(localPath, false));

        writeFileSync(localPath, 'export const value = 2;\n');
        strictEqual(cache.hasFresh(localPath, false, -1), false);
        strictEqual(cache.load(localPath, false, -1), null);

        const remotePath = join(root, 'remote.ts').replaceAll('\\', '/');
        writeFileSync(remotePath, 'export const remote = 1;\n');
        cache.persistBytecode(remotePath, new engine.Module('export const remote = 1;', remotePath).dump(), true);
        strictEqual(cache.hasFresh(remotePath, true), true);
        ok(existsSync(`${remotePath}.jsc`));
        ok(existsSync(`${remotePath}.jsc.mt`));
        strictEqual(cache.hasFresh(remotePath, true, -1), false);
        strictEqual(cache.load(remotePath, true, -1), null);
        strictEqual(existsSync(`${remotePath}.jsc`), false);
        strictEqual(existsSync(`${remotePath}.jsc.mt`), false);

        cache.setMemory('memory-module', new engine.Module('export const memory = 1;', 'memory-module').dump());
        ok(cache.load('memory-module', false));
        strictEqual(cache.load('memory-module', false), null);
    });
});
