import { deepStrictEqual, ok, strictEqual, throws } from 'node:assert';
import { existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createConfig } from '../../cts/src/config.ts';
import { runSync, StepType, type Flow, type Step } from '../../cts/src/flow.ts';
import { DataHandler } from '../../cts/src/resolve/protocols/data.ts';
import { FileHandler } from '../../cts/src/resolve/protocols/file.ts';
import { HttpHandler } from '../../cts/src/resolve/protocols/http.ts';
import { JsrHandler } from '../../cts/src/resolve/protocols/jsr.ts';
import { JscCache } from '../../cts/src/source/cache.ts';
import { joinPaths, normalizePath } from '../../cts/src/utils/path.ts';
import { withTempDir } from '../_helpers/temp.ts';

const engine = import.meta.use('engine');
const crypto = import.meta.use('crypto');

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

Deno.test('cts protocols: cached-only rejects HTTP and JSR misses before network', async () => {
    await withTempDir('cts-cached-only-protocols', (root) => {
        const cacheDir = joinPaths(root, 'cache');
        const http = new HttpHandler(createConfig({ cacheDir, cachedOnly: true, silent: true }));
        throws(() => drive(http.resolve('https://example.test/missing.ts', '/entry.ts'), (step) => {
            if (step.type === StepType.FS_EXISTS) return false;
            throw new Error(`unexpected network step ${step.type}`);
        }), /--cached-only/);

        const jsr = new JsrHandler(createConfig({ cacheDir, cachedOnly: true, silent: true }));
        throws(() => drive(jsr.resolve('jsr:@scope/pkg@1.0.0/mod.ts', '/entry.ts'), (step) => {
            if (step.type === StepType.FS_EXISTS) return false;
            throw new Error(`unexpected network step ${step.type}`);
        }), /--cached-only/);
    });
});

Deno.test('cts jsr protocol: verifies manifest checksum before writing downloaded bytes', async () => {
    await withTempDir('cts-jsr-integrity', (root) => {
        const cacheDir = joinPaths(root, 'cache');
        const handler = new JsrHandler(createConfig({ cacheDir, silent: true }));
        const source = engine.encodeString('export const value = 1;\n');
        const metadata = engine.encodeString(JSON.stringify({
            manifest: { '/mod.ts': {
                size: source.byteLength,
                checksum: `sha256-${crypto.hexEncode(crypto.sha256(source))}`,
            } },
        }));
        const steps: Step[] = [];
        const info = drive(handler.resolve('jsr:@scope/pkg@1.0.0/mod.ts', '/entry.ts'), (step) => {
            steps.push(step);
            if (step.type === StepType.FS_EXISTS) return false;
            if (step.type === StepType.NET_FETCH) {
                return step.url.endsWith('/1.0.0_meta.json')
                    ? { status: 200, headers: [], body: metadata }
                    : { status: 200, headers: [], body: source };
            }
            if (step.type === StepType.FS_ENSURE_DIR || step.type === StepType.FS_WRITE_BYTES || step.type === StepType.FS_WRITE_TEXT) {
                return undefined;
            }
            throw new Error(`unexpected step ${step.type}`);
        });
        strictEqual(info.specPath, 'jsr:@scope/pkg@1.0.0/mod.ts');
        strictEqual(steps.filter((step) => step.type === StepType.NET_FETCH).length, 2);

        const bad = new JsrHandler(createConfig({ cacheDir: joinPaths(root, 'bad-cache'), silent: true }));
        throws(() => drive(bad.resolve('jsr:@scope/pkg@1.0.0/mod.ts', '/entry.ts'), (step) => {
            if (step.type === StepType.FS_EXISTS) return false;
            if (step.type === StepType.NET_FETCH) {
                return step.url.endsWith('/1.0.0_meta.json')
                    ? { status: 200, headers: [], body: metadata }
                    : { status: 200, headers: [], body: engine.encodeString('tampered') };
            }
            return undefined;
        }), /Integrity check failed/);
    });
});

Deno.test('cts jsr protocol: rejects metadata paths outside the package cache', async () => {
    await withTempDir('cts-jsr-path-containment', (root) => {
        const cacheDir = joinPaths(root, 'cache');
        const versionDir = joinPaths(cacheDir, 'jsr', 'scope', 'pkg', '1.0.0');
        const source = engine.encodeString('export const value = 1;\n');
        const checksum = `sha256-${crypto.hexEncode(crypto.sha256(source))}`;

        for (const target of ['../../../../../escaped.ts', '..\\..\\..\\..\\..\\escaped.ts']) {
            const metadata = engine.encodeString(JSON.stringify({
                exports: { '.': target },
                manifest: { [`/${target}`]: { size: source.byteLength, checksum } },
            }));
            const steps: Step[] = [];
            const handler = new JsrHandler(createConfig({ cacheDir, silent: true }));

            throws(() => drive(handler.resolve('jsr:@scope/pkg@1.0.0', '/entry.ts'), (step) => {
                steps.push(step);
                if (step.type === StepType.FS_EXISTS) return false;
                if (step.type === StepType.NET_FETCH) {
                    if (!step.url.endsWith('/1.0.0_meta.json')) {
                        throw new Error(`unsafe path reached file fetch: ${step.url}`);
                    }
                    return { status: 200, headers: [], body: metadata };
                }
                if (step.type === StepType.FS_ENSURE_DIR || step.type === StepType.FS_WRITE_TEXT) return undefined;
                throw new Error(`unsafe path reached step ${step.type}`);
            }), /Unsafe JSR module path/);

            strictEqual(steps.filter((step) => step.type === StepType.NET_FETCH).length, 1);
            for (const step of steps) {
                if (step.type !== StepType.FS_ENSURE_DIR && step.type !== StepType.FS_WRITE_TEXT &&
                    step.type !== StepType.FS_WRITE_BYTES) continue;
                const path = normalizePath(step.path);
                ok(path === versionDir || path.startsWith(versionDir + '/'), `path escaped package cache: ${path}`);
            }
        }
    });
});

Deno.test('cts jsr protocol: localPath rejects escaping specifier paths', () => {
    const handler = new JsrHandler(createConfig({ cacheDir: '/tmp/cts-jsr-local-path', silent: true }));
    throws(
        () => handler.localPath('jsr:@scope/pkg@1.0.0/../../outside.ts'),
        /Unsafe JSR module path/,
    );
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

        const remotePath = join(cacheDir, 'remote.ts').replaceAll('\\', '/');
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

Deno.test('cts jsc cache: module identity invalidates same-file bytecode and external remote files stay isolated', async () => {
    await withTempDir('cts-jsc-identity', (root) => {
        const cacheDir = joinPaths(root, 'cache');
        const workspaceDir = join(root, 'workspace');
        const sourcePath = join(workspaceDir, 'socket.ts').replaceAll('\\', '/');
        const packageDir = join(cacheDir, 'npm', 'http');
        const localPath = join(packageDir, 'socket.ts').replaceAll('\\', '/');
        const oldId = 'npm:@cnojs/http@1.0.0/c/socket.ts';
        const currentId = 'npm:@cnojs/http@1.0.0/src/socket.ts';
        mkdirSync(workspaceDir, { recursive: true });
        mkdirSync(join(cacheDir, 'npm'), { recursive: true });
        writeFileSync(sourcePath, 'export const socket = 1;\n');
        symlinkSync(workspaceDir, packageDir, 'dir');

        const cache = new JscCache(cacheDir);
        const oldBytecode = new engine.Module('export const socket = 1;', oldId).dump();
        cache.persistBytecode(localPath, oldBytecode, true, oldId);

        strictEqual(cache.hasFresh(localPath, true, undefined, oldId), true);
        strictEqual(cache.hasFresh(localPath, true, undefined, currentId), false);
        ok(cache.loadRawBytes(localPath, true, undefined, oldId));
        strictEqual(cache.load(localPath, true, undefined, currentId), null);
        strictEqual(existsSync(`${localPath}.jsc`), false);
        strictEqual(existsSync(`${localPath}.jsc.mt`), false);

        const currentBytecode = new engine.Module('export const socket = 1;', currentId).dump();
        cache.persistBytecode(localPath, currentBytecode, true, currentId);
        ok(cache.load(localPath, true, undefined, currentId));

        const memoryPath = 'memory-socket';
        cache.setMemory(memoryPath, oldBytecode, oldId);
        strictEqual(cache.load(memoryPath, false, undefined, currentId), null);
        ok(cache.load(memoryPath, false, undefined, oldId));
    });
});
