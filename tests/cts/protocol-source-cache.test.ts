import { deepStrictEqual, ok, strictEqual, throws } from 'node:assert';
import { existsSync, mkdirSync, readFileSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createConfig } from '../../cts/src/config.ts';
import { EsmCompiler } from '../../cts/src/compile/esm.ts';
import { runSync, StepType, type Flow, type Step } from '../../cts/src/flow.ts';
import { DataHandler } from '../../cts/src/resolve/protocols/data.ts';
import { FileHandler } from '../../cts/src/resolve/protocols/file.ts';
import { HttpHandler } from '../../cts/src/resolve/protocols/http.ts';
import { JsrHandler } from '../../cts/src/resolve/protocols/jsr.ts';
import { JscCache } from '../../cts/src/source/cache.ts';
import type { ModuleInfo } from '../../cts/src/types.ts';
import { joinPaths, normalizePath } from '../../cts/src/utils/path.ts';
import { err, ErrorKind } from '../../cts/src/errors.ts';
import { withTempDir } from '../_helpers/temp.ts';

const engine = import.meta.use('engine');
const crypto = import.meta.use('crypto');
const fs = import.meta.use('fs');

function drive<T>(flow: Flow<T>, handler: (step: Step) => unknown): T {
    let state = flow.next();
    while (!state.done) {
        try {
            state = flow.next(handler(state.value as Step));
        } catch (error) {
            state = flow.throw(error);
        }
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

Deno.test('cts jsc cache: a cold check captures freshness for the first bytecode write', async () => {
    await withTempDir('cts-jsc-cold-check', (root) => {
        const cacheDir = joinPaths(root, 'cache');
        const localPath = join(cacheDir, 'remote.ts').replaceAll('\\', '/');
        const source = 'export const value = 42;\n';
        mkdirSync(cacheDir, { recursive: true });
        writeFileSync(localPath, source);

        const cache = new JscCache(cacheDir);
        strictEqual(existsSync(`${localPath}.jsc`), false);
        const check = cache.checkFreshness(localPath, true);
        strictEqual(check.fresh, false);
        const snapshot = check.snapshot;
        ok(snapshot, 'a cold check must retain the source snapshot');
        strictEqual(engine.decodeString(snapshot.bytes), source);

        const mod = new engine.Module('export const value = 42;', localPath);
        mod.resolve();
        cache.persistBytecode(localPath, mod.dump(), true, undefined, snapshot.freshness);
        ok(existsSync(`${localPath}.jsc`));
        strictEqual(cache.hasFresh(localPath, true), true);
    });
});

Deno.test('cts jsr protocol: refreshes invalid cached metadata but preserves cache read errors', () => {
    const cacheDir = '/tmp/cts-jsr-cache-errors';
    const source = engine.encodeString('export const value = 1;\n');
    const metadata = engine.encodeString(JSON.stringify({
        manifest: { '/mod.ts': { checksum: `sha256-${crypto.hexEncode(crypto.sha256(source))}` } },
    }));
    const refreshedRequests: string[] = [];
    let existsCalls = 0;

    const refreshed = drive(
        new JsrHandler(createConfig({ cacheDir, silent: true })).resolve('jsr:@scope/pkg@1.0.0/mod.ts', '/entry.ts'),
        (step) => {
            if (step.type === StepType.FS_EXISTS) return ++existsCalls === 1;
            if (step.type === StepType.FS_READ_TEXT) return '{ not json';
            if (step.type === StepType.NET_FETCH) {
                refreshedRequests.push(step.url);
                return step.url.endsWith('_meta.json')
                    ? { status: 200, headers: [], body: metadata }
                    : { status: 200, headers: [], body: source };
            }
            if (step.type === StepType.FS_ENSURE_DIR || step.type === StepType.FS_WRITE_TEXT || step.type === StepType.FS_WRITE_BYTES) {
                return undefined;
            }
            throw new Error(`unexpected step ${step.type}`);
        },
    );
    strictEqual(refreshed.fileKind, 'source');
    strictEqual(refreshedRequests.length, 2);
    ok(refreshedRequests[0]!.endsWith('/1.0.0_meta.json'));

    const readFailure = err(ErrorKind.PermissionError, 'cache read denied');
    let requestedNetwork = false;
    throws(
        () => drive(
            new JsrHandler(createConfig({ cacheDir, silent: true })).resolve('jsr:@scope/pkg@1.0.0/mod.ts', '/entry.ts'),
            (step) => {
                if (step.type === StepType.FS_EXISTS) return true;
                if (step.type === StepType.FS_READ_TEXT) throw readFailure;
                if (step.type === StepType.NET_FETCH) requestedNetwork = true;
                throw new Error(`unexpected step ${step.type}`);
            },
        ),
        (error: unknown) => error === readFailure,
    );
    strictEqual(requestedNetwork, false);
});

Deno.test('cts jsc cache: a disk miss exposes the already-read source snapshot', async () => {
    await withTempDir('cts-jsc-source-snapshot-reuse', (root) => {
        const cacheDir = joinPaths(root, 'cache');
        const localPath = join(root, 'entry.ts').replaceAll('\\', '/');
        writeFileSync(localPath, 'export const value = 1;\n');

        const cache = new JscCache(cacheDir);
        const old = new engine.Module('export const value = 1;', localPath);
        old.resolve();
        cache.persistLocal(localPath, old, localPath);

        // A changed source forces the disk lookup down its miss path. The
        // compiler can consume the exact bytes read for the freshness check.
        writeFileSync(localPath, 'export const value = 2;\n');
        const nativeReadFile = fs.readFile;
        const nativeStat = fs.stat;
        let sourceReads = 0;
        let sourceStats = 0;
        Reflect.set(fs, 'readFile', (path: string) => {
            if (path === localPath) sourceReads++;
            return nativeReadFile(path);
        });
        Reflect.set(fs, 'stat', (path: string) => {
            if (path === localPath) sourceStats++;
            return nativeStat(path);
        });
        try {
            strictEqual(cache.load(localPath, false, undefined, localPath), null);
        } finally {
            Reflect.set(fs, 'readFile', nativeReadFile);
            Reflect.set(fs, 'stat', nativeStat);
        }
        strictEqual(sourceReads, 1, 'cache miss reads source bytes once');
        strictEqual(sourceStats, 1, 'cache miss stats source once');
        const snapshot = cache.takeSourceSnapshot(localPath, localPath);
        ok(snapshot);
        strictEqual(engine.decodeString(snapshot.bytes), 'export const value = 2;\n');
        strictEqual(snapshot.freshness.size, snapshot.bytes.byteLength);
        strictEqual(cache.takeSourceSnapshot(localPath, localPath), undefined);

        // A cache hit is fully consumed inside JscCache and leaves no stale
        // source buffer behind; L1 memory hits also avoid a disk read.
        const fresh = new engine.Module('export const value = 2;', localPath);
        fresh.resolve();
        cache.persistLocal(localPath, fresh, localPath);
        ok(cache.load(localPath, false, undefined, localPath));
        strictEqual(cache.takeSourceSnapshot(localPath, localPath), undefined);
    });
});

Deno.test('cts jsc cache: normalized cache roots keep remote bytecode adjacent', async () => {
    await withTempDir('cts-jsc-cache-root', (root) => {
        const cacheDir = joinPaths(root, 'cache');
        const configured = cacheDir + '//';
        const cfg = createConfig({ cacheDir: configured });
        strictEqual(cfg.cacheDir, normalizePath(cacheDir));

        const remotePath = joinPaths(cacheDir, 'http', 'remote.ts');
        mkdirSync(joinPaths(cacheDir, 'http'), { recursive: true });
        writeFileSync(remotePath, 'export const remote = 1;\n');
        const cache = new JscCache(configured);
        cache.persistBytecode(remotePath, new engine.Module('export const remote = 1;', remotePath).dump(), true);
        ok(existsSync(remotePath + '.jsc'));
        ok(existsSync(remotePath + '.jsc.mt'));
    });
});

Deno.test('cts jsc cache: persistence keeps the pre-compile source stamp', async () => {
    await withTempDir('cts-jsc-source-snapshot', (root) => {
        const cacheDir = joinPaths(root, 'cache');
        const localPath = join(root, 'entry.ts').replaceAll('\\', '/');
        writeFileSync(localPath, 'export const value = 1;\n');

        const cache = new JscCache(cacheDir);
        const source = cache.captureFreshness(localPath);
        ok(source, 'source snapshot must be captured before compilation');
        const oldBytecode = new engine.Module('export const value = 1;', localPath).dump();

        // Same-size replacement reproduces the dangerous case: old bytecode is
        // persisted after the source changed, so a post-compile stat would bless it.
        writeFileSync(localPath, 'export const value = 2;\n');
        const changedAt = Math.floor(Date.now() / 1000) + 2;
        fs.utimes(localPath, changedAt, changedAt);
        cache.persistBytecode(localPath, oldBytecode, false, localPath, source);
        strictEqual(cache.hasFresh(localPath, false, undefined, localPath), false);
        strictEqual(cache.load(localPath, false, undefined, localPath), null);
    });
});

Deno.test('cts jsc cache: same-size edits invalidate when the mtime moves within the second', async () => {
    await withTempDir('cts-jsc-same-second', (root) => {
        const cacheDir = joinPaths(root, 'cache');
        const localPath = join(root, 'entry.ts').replaceAll('\\', '/');
        const original = 'export const value = 1;\n';
        const edited = 'export const value = 2;\n';
        strictEqual(original.length, edited.length, 'the hazard requires an identical size');

        // Pin the mtime to an exact sub-second instant. A stamp that renders the
        // mtime with second granularity cannot distinguish .1 from .9 below.
        const pinnedAt = 1785640800.1;
        writeFileSync(localPath, original);
        fs.utimes(localPath, pinnedAt, pinnedAt);

        const cache = new JscCache(cacheDir);
        const source = cache.captureFreshness(localPath);
        ok(source, 'source snapshot must be captured before compilation');
        const mod = new engine.Module(original, localPath);
        mod.resolve();
        cache.persistLocal(localPath, mod, localPath, source);
        strictEqual(cache.hasFresh(localPath, false, undefined, localPath), true);

        // Same size, mtime still inside the same wall-clock second. The stamp
        // keeps full precision, so the stat-only fast tier declines and the
        // slow tier's content hash rejects the edit.
        writeFileSync(localPath, edited);
        fs.utimes(localPath, 1785640800.9, 1785640800.9);
        strictEqual(cache.hasFresh(localPath, false, undefined, localPath), false);
    });
});

Deno.test('cts jsc cache: content identity decides — a restored-mtime same-size edit still invalidates', async () => {
    await withTempDir('cts-jsc-content-authority', (root) => {
        const cacheDir = joinPaths(root, 'cache');
        const localPath = join(root, 'entry.ts').replaceAll('\\', '/');
        const original = 'export const value = 1;\n';
        const sameSizeEdit = 'export const value = 2;\n';
        strictEqual(original.length, sameSizeEdit.length, 'the hazard requires an identical size');

        const pinnedAt = 1785640800.1;
        writeFileSync(localPath, original);
        fs.utimes(localPath, pinnedAt, pinnedAt);
        const cache = new JscCache(cacheDir);
        const source = cache.captureFreshness(localPath);
        ok(source);
        const mod = new engine.Module(original, localPath);
        mod.resolve();
        cache.persistLocal(localPath, mod, localPath, source);

        // Unchanged content stays fresh: the hash is recomputed on every disk
        // hit and has to agree with the stamp, otherwise every run recompiles.
        strictEqual(cache.hasFresh(localPath, false, undefined, localPath), true);
        ok(cache.load(localPath, false, undefined, localPath));

        // A touch-restored same-content edit stays fresh: the hash re-decides
        // in the content's favor instead of recompiling.
        writeFileSync(localPath, original);
        fs.utimes(localPath, pinnedAt + 5, pinnedAt + 5);
        strictEqual(cache.hasFresh(localPath, false, undefined, localPath), true);
        ok(cache.load(localPath, false, undefined, localPath));

        // The stat cannot see this edit: a same-size write with the mtime
        // restored to the original value reads identical mtime+size. The
        // content hash is the authority on every disk hit and invalidates.
        writeFileSync(localPath, sameSizeEdit);
        fs.utimes(localPath, pinnedAt, pinnedAt);
        strictEqual(cache.hasFresh(localPath, false, undefined, localPath), false);
        strictEqual(cache.load(localPath, false, undefined, localPath), null);
        strictEqual(existsSync(`${localPath}.jsc`), false);
        strictEqual(existsSync(`${localPath}.jsc.mt`), false);

        // After the invalidation the next check is a cold miss.
        writeFileSync(localPath, original);
        fs.utimes(localPath, pinnedAt + 15, pinnedAt + 15);
        strictEqual(cache.hasFresh(localPath, false, undefined, localPath), false);
    });
});

Deno.test('cts jsc cache: an untouched source still hits the cache after the stamp upgrade', async () => {
    await withTempDir('cts-jsc-still-hits', (root) => {
        const cacheDir = joinPaths(root, 'cache');
        const localPath = join(root, 'entry.ts').replaceAll('\\', '/');
        writeFileSync(localPath, 'export const value = 1;\n');

        const cache = new JscCache(cacheDir);
        const source = cache.captureFreshness(localPath);
        ok(source);
        strictEqual(source.hash.length, 32, 'stamp carries an md5 of the source bytes');
        const mod = new engine.Module('export const value = 1;', localPath);
        mod.resolve();
        cache.persistLocal(localPath, mod, localPath, source);

        // Repeated checks must stay fresh: the hash is recomputed on every check and
        // has to agree with itself, otherwise every run would recompile.
        strictEqual(cache.hasFresh(localPath, false, undefined, localPath), true);
        strictEqual(cache.hasFresh(localPath, false, undefined, localPath), true);
        ok(cache.load(localPath, false, undefined, localPath));

        // mtime stays part of the stamp so a resolver-supplied mtime can still force
        // invalidation (see the -1 cases above), but a bare touch of unchanged
        // content stays fresh: the hash re-decides in the content's
        // favor instead of recompiling.
        const laterAt = Math.floor(Date.now() / 1000) + 5;
        fs.utimes(localPath, laterAt, laterAt);
        strictEqual(cache.hasFresh(localPath, false, undefined, localPath), true);
        ok(cache.load(localPath, false, undefined, localPath));
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

Deno.test('cts jsc cache: sidecar and bytecode cross-pairs are rejected by the bytecode digest', async () => {
    await withTempDir('cts-jsc-bytecode-generation', (root) => {
        const cacheDir = joinPaths(root, 'cache');
        const localPath = join(cacheDir, 'remote.ts').replaceAll('\\', '/');
        const firstId = 'npm:pkg@1.0.0/first.ts';
        const secondId = 'npm:pkg@1.0.0/second.ts';
        mkdirSync(cacheDir, { recursive: true });
        writeFileSync(localPath, 'export const value = 1;\n');

        const cache = new JscCache(cacheDir);
        const first = new engine.Module('export const value = 1;', firstId);
        const second = new engine.Module('export const value = 2;', secondId);
        first.resolve();
        second.resolve();
        cache.persistBytecode(localPath, first.dump(), true, firstId);
        const firstSidecar = readFileSync(`${localPath}.jsc.mt`);
        cache.persistBytecode(localPath, second.dump(), true, secondId);

        // This is the interleaving a pair of non-transactional writers can
        // expose: the sidecar still names the first module while .jsc is from
        // the second writer. Source freshness and module identity alone do not
        // detect it; the bytecode digest must.
        writeFileSync(`${localPath}.jsc.mt`, firstSidecar);
        strictEqual(cache.hasFresh(localPath, true, undefined, firstId), false);
        strictEqual(cache.load(localPath, true, undefined, firstId), null);
        ok(existsSync(`${localPath}.jsc`), 'a raced pair is left for its writer to repair');
        ok(existsSync(`${localPath}.jsc.mt`));
    });
});

Deno.test('cts jsc cache: remote ownership follows a retargeted symlink', async () => {
    await withTempDir('cts-jsc-symlink-retarget', (root) => {
        const cacheDir = joinPaths(root, 'cache');
        const inside = join(cacheDir, 'inside.ts');
        const outside = join(root, 'outside.ts');
        const link = join(cacheDir, 'module.ts');
        mkdirSync(cacheDir, { recursive: true });
        writeFileSync(inside, 'export const value = 1;\n');
        writeFileSync(outside, 'export const value = 2;\n');
        symlinkSync(inside, link, 'file');

        const cache = new JscCache(cacheDir);
        cache.persistBytecode(link, new engine.Module('export const value = 1;', link).dump(), true, link);
        ok(existsSync(`${link}.jsc`), 'an in-root target uses adjacent remote storage');
        unlinkSync(`${link}.jsc`);
        unlinkSync(`${link}.jsc.mt`);

        unlinkSync(link);
        symlinkSync(outside, link, 'file');
        cache.persistBytecode(link, new engine.Module('export const value = 2;', link).dump(), true, link);
        strictEqual(existsSync(`${link}.jsc`), false, 'a retargeted outside target uses the hashed cache');
        strictEqual(cache.hasFresh(link, true, undefined, link), true);
    });
});

Deno.test('cts esm compiler: local .json modules persist and warm-load through the bytecode cache', async () => {
    await withTempDir('cts-jsc-json', (root) => {
        const cacheDir = joinPaths(root, 'cache');
        const localPath = joinPaths(root, 'data.json');
        writeFileSync(localPath, '{"value":1}');
        const info: ModuleInfo = {
            specPath: `file://${localPath.replaceAll('\\', '/')}`,
            localPath,
            format: 'esm',
            fileKind: 'json',
        };

        const first = new EsmCompiler(createConfig({ cacheDir, enableCache: true, silent: true }));
        const compiled = first.load(info);
        compiled.resolve();
        engine.promiseResult(compiled.eval());
        deepStrictEqual(compiled.namespace.default, { value: 1 });
        const moduleId = info.specPath;
        ok(first.jsc.hasFresh(localPath, false, undefined, moduleId), 'fresh .json module is a cache candidate');

        // A second compiler shares only the L2 disk cache: the wrapper bytecode
        // is served without re-reading or re-parsing the source.
        const second = new EsmCompiler(createConfig({ cacheDir, enableCache: true, silent: true }));
        const warm = second.load(info);
        warm.resolve();
        engine.promiseResult(warm.eval());
        deepStrictEqual(warm.namespace.default, { value: 1 });
    });
});
