/**
 * require.resolve() must be INSPECTION ONLY — no network, no install.
 *
 * Regression: `require.resolve('left-pad')` in a project that does not depend on
 * left-pad returned a path under cno where node v24.18.0 throws MODULE_NOT_FOUND,
 * because require.resolve shared resolveId() with require() and therefore
 * inherited npm's install-on-demand. Two consequences, both covered below:
 *   1. every `try { require.resolve(x) } catch { fallback }` probe took the wrong
 *      branch (measured on eslint's loadFormatter, which silently loaded
 *      eslint-formatter-json@9.0.1 + 9 transitive deps instead of its bundled one);
 *   2. require.resolve became network I/O that fetches and executes registry
 *      code from a call the caller believes is a pure local lookup. Measured with
 *      NPM_CONFIG_REGISTRY=http://127.0.0.1:1 — the call reported
 *      "Failed to connect to 127.0.0.1:1", i.e. it really opened a socket.
 *
 * These import cts sources by relative path, so they exercise the TypeScript on
 * disk, NOT the copy baked into the binary. cts/src/** is not refreshed by
 * `cno setup`, so the binary keeps the old behaviour until a rebuild; this file
 * is what proves the source-level fix before that rebuild.
 *
 * SCOPE: the spy tests below prove require.resolve routes to the *cached* dep and
 * require() does not. The resolver test proves resolveForInspection really is
 * no-fetch against a real ModuleResolver + real store. Neither runs the binary.
 */
import { ok, strictEqual, deepStrictEqual, throws } from 'node:assert';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { CjsLoader } from '../../cts/src/compile/cjs.ts';
import type { CjsDeps } from '../../cts/src/compile/cjs.ts';
import { ModuleResolver } from '../../cts/src/resolve/index.ts';
import { createConfig } from '../../cts/src/config.ts';
import { joinPaths } from '../../cts/src/utils/path.ts';
import { makePosixTempDir } from '../_helpers/temp.ts';
import type { ModuleInfo } from '../../cts/src/types.ts';

interface Calls { plain: string[]; cached: string[] }

/**
 * CjsLoader wired to two distinguishable resolvers. `plain` stands for the
 * fetching path (what require() must keep using), `cached` for the no-fetch
 * inspection path (what require.resolve must use). Only `cached` knows
 * 'in-store-pkg', so a resolve that answers it proves which one ran.
 */
function makeLoader(calls: Calls, opts: { withCached?: boolean } = {}) {
    const info = (p: string): ModuleInfo => ({
        specPath: p, localPath: p, format: 'cjs', fileKind: 'source',
    });
    const deps: Partial<CjsDeps> = {
        resolveBuiltin(name: string) {
            return info(`node:${name}`);
        },
        loadEsmSync() { return {}; },
        resolveExternal(req: string): ModuleInfo | null {
            calls.plain.push(req);
            // The fetching resolver can answer anything (it installs on demand).
            if (req.startsWith('.') || req.startsWith('/')) return null;
            return info(`/store/fetched/${req}/index.js`);
        },
        prepareSource(code: string) { return code; },
    };
    if (opts.withCached !== false) {
        deps.resolveExternalCached = (req: string): ModuleInfo | null => {
            calls.cached.push(req);
            if (req === 'in-store-pkg') return info('/store/local/in-store-pkg/index.js');
            return null; // everything else is a miss: not local, and we must not fetch
        };
    }
    return new CjsLoader(deps as CjsDeps);
}

// --- 1. require.resolve uses the no-fetch resolver, require() does not -------

Deno.test('require.resolve: routes to the cached (no-fetch) resolver, not the fetching one', () => {
    const calls: Calls = { plain: [], cached: [] };
    const req = makeLoader(calls).mkRequire('/proj/entry.cjs');

    // toHostPath() switches separators on Windows; compare separator-insensitively.
    strictEqual(
        req.resolve('in-store-pkg').replaceAll('\\', '/'),
        '/store/local/in-store-pkg/index.js',
    );
    deepStrictEqual(calls.cached, ['in-store-pkg']);
    // THE ASSERTION THAT MATTERS: the fetching resolver was never consulted.
    deepStrictEqual(calls.plain, []);
});

Deno.test('require.resolve: an undeclared, not-local package THROWS instead of fetching', () => {
    const calls: Calls = { plain: [], cached: [] };
    const req = makeLoader(calls).mkRequire('/proj/entry.cjs');

    throws(
        () => req.resolve('left-pad'),
        (e: unknown) => {
            ok(e instanceof Error);
            // node v24.18.0 wording + code, measured.
            strictEqual(Reflect.get(e, 'code'), 'MODULE_NOT_FOUND');
            ok(/^Cannot find module 'left-pad'/.test(e.message), `message: ${e.message}`);
            ok(Array.isArray(Reflect.get(e, 'requireStack')), 'node exposes err.requireStack');
            return true;
        },
    );
    deepStrictEqual(calls.cached, ['left-pad']);
    // The whole point: no fetch was attempted for a name only the registry has.
    deepStrictEqual(calls.plain, [], 'require.resolve must not reach the fetching resolver');
});

Deno.test('require(): still uses the fetching resolver — the fix must not break loading', () => {
    const calls: Calls = { plain: [], cached: [] };
    const loader = makeLoader(calls);
    const req = loader.mkRequire('/proj/entry.cjs');

    // Resolution reaches the fetching resolver; the load then fails on missing
    // bytes, which is fine — we only assert WHICH resolver was consulted.
    try { req('left-pad'); } catch { /* load failure is not what this asserts */ }
    deepStrictEqual(calls.plain, ['left-pad'], 'require() must keep the install-on-demand path');
    deepStrictEqual(calls.cached, [], 'require() must not be downgraded to no-fetch');
});

// --- 2. graceful degradation for deps objects without the cached twin --------

Deno.test('require.resolve: falls back to resolveExternal when no cached twin exists', () => {
    const calls: Calls = { plain: [], cached: [] };
    const req = makeLoader(calls, { withCached: false }).mkRequire('/proj/entry.cjs');

    // Hand-built CjsDeps (several test files use them) must keep working rather
    // than resolving nothing at all.
    ok(req.resolve('anything').length > 0);
    deepStrictEqual(calls.plain, ['anything']);
});

// --- 3. builtins and resolve.paths, measured against node v24.18.0 ----------

Deno.test('require.resolve: builtins return the specifier verbatim, never a path', () => {
    const calls: Calls = { plain: [], cached: [] };
    const req = makeLoader(calls).mkRequire('/proj/entry.cjs');

    // node: require.resolve('fs') === 'fs', require.resolve('node:fs') === 'node:fs'.
    // Was returning <cache>/node/fs/index.ts, which makes bundlers treat a
    // builtin as a bundleable file.
    strictEqual(req.resolve('fs'), 'fs');
    strictEqual(req.resolve('node:fs'), 'node:fs');
    strictEqual(req.resolve('node:test'), 'node:test');
    // Resolved without consulting any resolver at all.
    deepStrictEqual(calls.cached, []);
    deepStrictEqual(calls.plain, []);
});

Deno.test('require.resolve.paths: exists, and is null for builtins', () => {
    const calls: Calls = { plain: [], cached: [] };
    const req = makeLoader(calls).mkRequire('/proj/sub/entry.cjs');

    strictEqual(typeof req.resolve.paths, 'function', 'node exposes require.resolve.paths');
    strictEqual(req.resolve.paths('fs'), null, 'node returns null for builtins');
    strictEqual(req.resolve.paths('node:fs'), null);

    const bare = req.resolve.paths('some-pkg');
    ok(Array.isArray(bare) && bare.length > 1, 'bare specifier walks up node_modules');
    ok(bare.every(p => p.endsWith('node_modules')), `all entries are node_modules dirs: ${bare.join(', ')}`);

    const rel = req.resolve.paths('./x');
    ok(Array.isArray(rel));
    strictEqual(rel.length, 1, 'node returns a single dir for a relative specifier');
});

// --- 4. real ModuleResolver: resolveForInspection is genuinely no-fetch ------

Deno.test('resolveForInspection: store miss is a miss, and cachedOnly is restored', () => {
    const root = makePosixTempDir('req-resolve-nofetch');
    try {
        const cacheDir = joinPaths(root, 'cache');
        const projectDir = joinPaths(root, 'project');
        mkdirSync(join(projectDir), { recursive: true });
        // Store has dep@1.0.0 only. Asking for ^2.0.0 cannot be satisfied
        // locally, so a fetching resolve would go to the registry.
        const depDir = joinPaths(cacheDir, 'npm', 'dep@1.0.0');
        mkdirSync(join(depDir), { recursive: true });
        writeFileSync(join(depDir, 'index.js'), 'module.exports = 1;\n');
        writeFileSync(join(depDir, 'package.json'), JSON.stringify({
            name: 'dep', version: '1.0.0', main: 'index.js',
        }));
        writeFileSync(join(projectDir, 'entry.cjs'), 'module.exports = 1;\n');

        const cfg = createConfig({
            cacheDir,
            lockDir: projectDir,
            enableNode: false,
            enableHttp: false,
            enableJsr: false,
            silent: true,
            disableLock: true,
            ignoreScripts: true,
        });
        // Precondition: fetching is ENABLED. Without this the test would pass
        // vacuously — it would only be re-proving --cached-only.
        strictEqual(cfg.cachedOnly, false, 'must start with fetching enabled');
        const resolver = new ModuleResolver(cfg, projectDir, true);
        try {
            const entry = joinPaths(projectDir, 'entry.cjs');

            // In the store → resolves, offline, no network.
            const hit = resolver.resolveForInspection('npm:dep@1.0.0', entry, { cjs: true });
            ok(hit.localPath.includes('dep@1.0.0'), `got ${hit.localPath}`);

            // Not satisfiable from the store → must fail rather than fetch. If
            // no-fetch were not in force this would attempt a registry request.
            throws(
                () => resolver.resolveForInspection('npm:dep@^2.0.0', entry, { cjs: true }),
                (e: unknown) => {
                    ok(e instanceof Error);
                    // The cachedOnly bail names the cache, proving we took the
                    // local-only branch and never the download branch.
                    ok(
                        /cache|not found|Cannot find|cached-only/i.test(e.message),
                        `expected a local-miss error, got: ${e.message}`,
                    );
                    return true;
                },
            );

            // The flag flip must not leak: a later fetching resolve has to see
            // cachedOnly === false again, or one require.resolve() would silently
            // put the whole process offline.
            strictEqual(cfg.cachedOnly, false, 'cachedOnly must be restored');
        } finally {
            resolver.close();
        }
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
});

// --- 5. structural guards: keep the reasoning attached to the code -----------

Deno.test('structural: require.resolve passes inspect=true and the WHY comment survives', () => {
    const cjsSrc = readFileSync(join(import.meta.dirname!, '../../cts/src/compile/cjs.ts'), 'utf8');
    const start = cjsSrc.indexOf('const resolve = ((id: string, opts?: { paths?: string[] })');
    ok(start >= 0, 'require.resolve factory not found — did the site move?');
    const body = cjsSrc.slice(start, start + 1200);
    // resolveId's third arg is what selects the no-fetch resolver.
    ok(/self\.resolveId\(id,\s*p,\s*true\)/.test(body), 'require.resolve must pass inspect=true');

    const resolverSrc = readFileSync(join(import.meta.dirname!, '../../cts/src/resolve/index.ts'), 'utf8');
    ok(resolverSrc.includes('resolveForInspection'), 'resolveForInspection missing');
    // This comment is the only thing stopping someone "simplifying" the split
    // away; the defect it documents is silent and re-introduces trivially.
    ok(
        resolverSrc.includes('DO NOT COLLAPSE IT BACK INTO resolve()'),
        'the reasoning comment on resolveForInspection was removed',
    );
    ok(resolverSrc.includes('inspection never fetches'), 'the one-sentence rule was removed');
});

Deno.test('structural: log.download goes to stderr, not stdout', () => {
    // `cno run build.js > out.js` embedded "✨ pkg@ver..." into out.js because
    // download progress used nativeLog. Progress is diagnostic → stderr.
    const src = readFileSync(join(import.meta.dirname!, '../../cts/src/utils/log.ts'), 'utf8');
    const start = src.indexOf('download(url: string)');
    ok(start >= 0);
    const body = src.slice(start, start + 200);
    ok(body.includes('nativeError'), 'log.download must write to stderr');
    ok(!body.includes('nativeLog'), 'log.download must not write to stdout');
});
