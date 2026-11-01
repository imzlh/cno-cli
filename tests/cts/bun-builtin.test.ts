import { deepStrictEqual, ok, strictEqual, throws } from 'node:assert';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CjsLoader, type CjsDeps } from '../../cts/src/compile/cjs.ts';
import { createConfig } from '../../cts/src/config.ts';
import { createRuntime } from '../../cts/src/api/index.ts';
import { ModuleResolver } from '../../cts/src/resolve/index.ts';
import { bunPayloadViewName, bunPayloadViewRef, canonicalBunSpecifier, isBunSpecifier } from '../../cts/src/resolve/bun-specifier.ts';
import { PackHandler } from '../../cts/src/resolve/protocols/pack.ts';
import type { PackManifest } from '../../cts/src/pack/format.ts';
import type { ModuleInfo } from '../../cts/src/types.ts';

function payloadDir(root: string): string {
    const dir = join(root, 'bun');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'index.js'), 'export default {};\n');
    writeFileSync(join(dir, 'sqlite.js'), 'export default class Database {}\n');
    return dir;
}

Deno.test('cts bun: the whole bun / bun:* family is reserved, only two names are canonical', () => {
    for (const spec of ['bun', 'bun:sqlite', 'bun:', 'bun:ffi', 'bun:sqlite/x', 'BUN:sqlite']) {
        ok(isBunSpecifier(spec), spec);
    }
    for (const spec of ['bunny', 'bun-x', 'node:bun', './bun', 'bunx']) {
        ok(!isBunSpecifier(spec), spec);
    }
    strictEqual(canonicalBunSpecifier('bun'), 'bun');
    strictEqual(canonicalBunSpecifier('bun:sqlite'), 'bun:sqlite');
    for (const spec of ['bun:', 'bun:ffi', 'bun:sqlite/', 'BUN:sqlite', 'bun:SQLITE']) {
        strictEqual(canonicalBunSpecifier(spec), null, spec);
    }
});

for (const method of ['resolve', 'resolveAsync'] as const) {
    Deno.test(`cts bun ${method}: canonical names map to the payload files and keep their identity`, async () => {
        const root = mkdtempSync(join(tmpdir(), 'cts-bun-'));
        const bunDir = payloadDir(root);
        const resolver = new ModuleResolver(createConfig({
            cacheDir: join(root, 'cache'), bunDir, disableLock: true, silent: true,
            enableHttp: false, enableJsr: false, cachedOnly: true,
        }), root);
        try {
            const bun = await resolver[method]('bun', join(root, 'a.ts'));
            strictEqual(bun.specPath, 'bun');
            strictEqual(bun.localPath, join(bunDir, 'index.js').replaceAll('\\', '/'));
            const sqlite = await resolver[method]('bun:sqlite', join(root, 'a.ts'));
            strictEqual(sqlite.specPath, 'bun:sqlite');
            strictEqual(sqlite.localPath, join(bunDir, 'sqlite.js').replaceAll('\\', '/'));
            strictEqual(resolver.getInfo('bun').localPath, bun.localPath);
        } finally {
            resolver.close();
            rmSync(root, { recursive: true, force: true });
        }
    });

    Deno.test(`cts bun ${method}: unknown or malformed bun:* fails before maps, lock and npm`, async () => {
        const root = mkdtempSync(join(tmpdir(), 'cts-bun-'));
        const bunDir = payloadDir(root);
        // The import map points every name at a real file; none may be consulted.
        writeFileSync(join(root, 'evil.js'), 'export default 1;\n');
        const imports: Record<string, string> = {};
        for (const name of ['bun:ffi', 'bun:', 'bun:sqlite/x']) imports[name] = join(root, 'evil.js');
        for (const frozen of [false, true]) {
            const resolver = new ModuleResolver(createConfig({
                cacheDir: join(root, 'cache'), bunDir, disableLock: true, silent: true,
                enableHttp: false, enableJsr: false, cachedOnly: true, frozen,
                importMap: imports,
            }), root);
            try {
                for (const spec of ['bun:ffi', 'bun:', 'bun:sqlite/x', 'BUN:sqlite', 'bun:sqlite ']) {
                    let caught: unknown;
                    try { await resolver[method](spec, join(root, 'a.ts')); } catch (e) { caught = e; }
                    ok(caught instanceof Error, `${spec} must throw`);
                    strictEqual(Reflect.get(caught, 'code'), 'ERR_UNKNOWN_BUILTIN_MODULE', spec);
                    ok(!/npm|frozen|lock/i.test(caught.message), `${spec}: ${caught.message}`);
                }
            } finally {
                resolver.close();
            }
        }
        rmSync(root, { recursive: true, force: true });
    });

    Deno.test(`cts bun ${method}: a missing payload or bunDir is an unavailable builtin, not an npm lookup`, async () => {
        const root = mkdtempSync(join(tmpdir(), 'cts-bun-'));
        try {
            for (const bunDir of [undefined, join(root, 'absent')]) {
                const resolver = new ModuleResolver(createConfig({
                    cacheDir: join(root, 'cache'), bunDir, disableLock: true, silent: true,
                    enableHttp: false, enableJsr: false, cachedOnly: true,
                }), root);
                try {
                    let caught: unknown;
                    try { await resolver[method]('bun', join(root, 'a.ts')); } catch (e) { caught = e; }
                    ok(caught instanceof Error);
                    strictEqual(Reflect.get(caught, 'code'), 'ERR_UNKNOWN_BUILTIN_MODULE');
                    ok(caught.message.includes('unavailable'), caught.message);
                } finally {
                    resolver.close();
                }
            }
        } finally {
            rmSync(root, { recursive: true, force: true });
        }
    });
}

function bunLoader() {
    const resolutions: string[] = [];
    const loads: string[] = [];
    const bun = { api: 'bun' };
    // The synthetic `bun` namespace carries the Bun object's keys and no `default`.
    const bunNs = { argv: [] };
    const sqliteNs = { Database: class {}, SQLiteError: class {}, constants: {}, Statement: class {} };
    const sqlite = { ...sqliteNs, default: sqliteNs.Database };
    const deps: CjsDeps = {
        resolveBuiltin(name): ModuleInfo {
            resolutions.push(name);
            if (name !== 'bun' && name !== 'bun:sqlite') throw new Error(`unexpected builtin ${name}`);
            return { specPath: name, localPath: `/payload/${name === 'bun' ? 'index' : 'sqlite'}.js`, format: 'esm', fileKind: 'source' };
        },
        loadEsmSync(info) {
            loads.push(info.specPath);
            return info.specPath === 'bun' ? bunNs : sqlite;
        },
        bunObject(info) {
            if (info.specPath !== 'bun') throw new Error(`unexpected bunObject ${info.specPath}`);
            return bun;
        },
        resolveExternal() { throw new Error('bun must never reach the external resolver'); },
        prepareSource: () => null,
    };
    return { loader: new CjsLoader(deps), resolutions, loads, bun, sqlite };
}

Deno.test('cts bun cjs: require("bun") is the ESM default and require.resolve is canonical', () => {
    const { loader, bun, loads } = bunLoader();
    const require = loader.mkRequire('/project/entry.cjs');
    strictEqual(require.resolve('bun'), 'bun');
    strictEqual(require.resolve('bun:sqlite'), 'bun:sqlite');
    strictEqual(require.resolve.paths('bun'), null);
    strictEqual(require.resolve.paths('bun:sqlite'), null);
    strictEqual(require('bun'), bun);
    strictEqual(require('bun'), bun, 'identity is stable across calls');
    strictEqual(Reflect.get(require('bun') as object, 'default'), undefined);
    deepStrictEqual(loads, ['bun'], 'payload is evaluated once');
});

Deno.test('cts bun cjs: require("bun:sqlite") is a stable namespace-like object', () => {
    const { loader, sqlite } = bunLoader();
    const require = loader.mkRequire('/project/entry.cjs');
    const view = require('bun:sqlite') as Record<string, unknown>;
    strictEqual(require('bun:sqlite'), view);
    strictEqual(view.__esModule, true);
    strictEqual(view.Database, sqlite.Database);
    strictEqual(view.default, sqlite.default);
    strictEqual(view.SQLiteError, sqlite.SQLiteError);
    ok('constants' in view && 'Statement' in view);
});

Deno.test('cts bun cjs: unknown or malformed bun:* never reaches deps', () => {
    const { loader, resolutions } = bunLoader();
    const require = loader.mkRequire('/project/entry.cjs');
    for (const id of ['bun:ffi', 'bun:', 'bun:sqlite/x', 'BUN:sqlite']) {
        for (const op of [() => require(id), () => require.resolve(id)]) {
            throws(op, (e: unknown) => Reflect.get(e as object, 'code') === 'ERR_UNKNOWN_BUILTIN_MODULE', id);
        }
        strictEqual(require.resolve.paths(id), null);
    }
    deepStrictEqual(resolutions, []);
});

Deno.test('cts bun esm: default import is the Bun object, but the namespace has no default key', async () => {
    const root = mkdtempSync(join(tmpdir(), 'cts-bun-esm-'));
    const bunDir = join(root, 'bun');
    mkdirSync(bunDir, { recursive: true });
    // Mirrors the real payload: `export default Bun` plus extra named exports that
    // native Bun does not expose (payloadOnly), and lifecycle values that exist
    // only as Bun object properties (argv).
    writeFileSync(join(bunDir, 'index.js'), [
        'const Bun = { argv: ["a"], env: { K: "v" }, version: "1.0.0", sleep() { return 1; } };',
        'export const payloadOnly = 1;',
        'export default Bun;',
        '',
    ].join('\n'));
    writeFileSync(join(bunDir, 'sqlite.js'), 'export class Database {}\nexport default Database;\n');
    writeFileSync(join(root, 'a.mjs'), [
        'import Bun, * as ns from "bun";',
        'import { argv, env, version } from "bun";',
        'import Database, * as sq from "bun:sqlite";',
        'globalThis.__bunDefault = Bun;',
        'const dyn = await import("bun");',
        'const again = await import("bun");',
        'globalThis.__bunProbe = {',
        '  hasDefault: Object.hasOwn(ns, "default"),',
        '  keys: Object.keys(ns),',
        '  names: Object.getOwnPropertyNames(ns),',
        '  dynHasDefault: Object.hasOwn(dyn, "default"),',
        '  dynIsNs: dyn === ns,',
        '  dynStable: dyn === again,',
        '  named: argv === Bun.argv && env === Bun.env && version === Bun.version,',
        '  sqliteDefault: Database === sq.Database,',
        '  sqliteHasDefault: Object.hasOwn(sq, "default"),',
        '};',
        '',
    ].join('\n'));
    writeFileSync(join(root, 'b.cjs'), [
        'const a = require("bun");',
        'globalThis.__bunCjsProbe = {',
        '  identity: a === globalThis.__bunDefault,',
        '  stable: require("bun") === a,',
        '  noDefault: a.default === undefined && !("default" in a),',
        '  resolved: require.resolve("bun"),',
        '};',
        '',
    ].join('\n'));

    const rt = createRuntime({
        cacheDir: join(root, 'cache'), disableLock: true, enableCache: false,
        silent: true, enableNode: false, bunDir,
    });
    try {
        const entry = await rt.loadEntry(join(root, 'a.mjs'), {}, 'js');
        await rt.compiler.evalTracked(entry);
        const esm = Reflect.get(globalThis, '__bunProbe');
        strictEqual(esm.hasDefault, false, 'namespace must not own default');
        strictEqual(esm.dynHasDefault, false, 'dynamic import namespace must not own default');
        deepStrictEqual(esm.keys, ['argv', 'env', 'version', 'sleep'], 'keys are Object.keys(Bun)');
        ok(!esm.names.includes('default') && !esm.names.includes('payloadOnly'), String(esm.names));
        strictEqual(esm.dynIsNs, true, 'namespace identity is stable across static and dynamic import');
        strictEqual(esm.dynStable, true);
        strictEqual(esm.named, true, 'named imports bind Bun object properties');
        strictEqual(esm.sqliteDefault, true);

        // CJS shares the same cached module and the same Bun object.
        const cjs = await rt.loadModule(join(root, 'b.cjs'), {}, 'js');
        await rt.compiler.evalTracked(cjs);
        const c = Reflect.get(globalThis, '__bunCjsProbe');
        strictEqual(c.identity, true, 'require("bun") must be the ESM default object');
        strictEqual(c.stable, true);
        strictEqual(c.noDefault, true);
        strictEqual(c.resolved, 'bun');
    } finally {
        rt.cleanup();
        for (const key of ['__bunProbe', '__bunCjsProbe', '__bunDefault']) Reflect.deleteProperty(globalThis, key);
        rmSync(root, { recursive: true, force: true });
    }
});

Deno.test('cts bun pack: the hidden payload view resolves from the staged payload, never from the manifest', () => {
    const root = mkdtempSync(join(tmpdir(), 'cts-bun-pack-'));
    const bunDir = payloadDir(root);
    const entryPath = join(root, 'entry.ts');
    writeFileSync(entryPath, '');
    const entry = 'pack:/entry.ts';
    // A pack holds the canonical edge only: no bun module and no payload view.
    const manifest: PackManifest = {
        entry,
        modules: { [entry]: { localPath: entryPath, format: 'esm', fileKind: 'source', offset: 0, length: 0, sourceOffset: 0, sourceLength: 0 } },
        edges: {},
        bytecodeVersion: 'test',
    };
    const resolver = new ModuleResolver(createConfig({
        cacheDir: join(root, 'cache'), bunDir, disableLock: true, silent: true,
        enableHttp: false, enableJsr: false, cachedOnly: true,
    }), root, true);
    resolver.registerPackHandler(new PackHandler(manifest));
    try {
        const bun = resolver.resolve('bun', entry);
        strictEqual(bun.specPath, 'bun');
        strictEqual(bun.moduleId, undefined);
        const ref = bunPayloadViewRef('bun');
        strictEqual(bunPayloadViewName(ref), 'bun');
        strictEqual(bunPayloadViewName('ctsview:source/bun'), null);
        const view = resolver.getInfo(ref);
        strictEqual(view.moduleId, ref);
        strictEqual(view.specPath, 'bun');
        strictEqual(view.localPath, bun.localPath);
        strictEqual(view.fileKind, 'source');
        // The pack handler alone cannot answer it: that was the relocated-pack failure.
        throws(() => new PackHandler(manifest).localPath(ref));
        const sqlite = resolver.getInfo(bunPayloadViewRef('bun:sqlite'));
        strictEqual(sqlite.localPath, resolver.resolve('bun:sqlite', entry).localPath);
        throws(() => resolver.getInfo('ctsview:bun-payload/bun:ffi'));
    } finally {
        resolver.close();
        rmSync(root, { recursive: true, force: true });
    }
});
