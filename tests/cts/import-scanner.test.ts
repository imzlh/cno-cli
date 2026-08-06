import { deepStrictEqual, ok, rejects, strictEqual, throws } from 'node:assert';
import { mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { makePosixTempDir } from '../_helpers/temp.ts';
import { createConfig } from '../../cts/src/config.ts';
import { DepScanner } from '../../cts/src/deps.ts';
import { hasImportAttributes, extractImports } from '../../cts/src/scan.ts';
import { ImportScanner } from '../../cts/src/import-scanner.ts';
import { LockStore } from '../../cts/src/lock.ts';
import { tryLoadOxc } from '../../cts/src/oxc.ts';
import { ModuleResolver } from '../../cts/src/resolve/index.ts';
import { ParseWorkerError } from '../../cts/src/parse.ts';

Deno.test('hasImportAttributes: cheap scan finds with/assert without full TS parse', () => {
    ok(hasImportAttributes(`import data from './x.json' with { type: 'json' };\n`));
    ok(hasImportAttributes(`export { x } from './y' assert { type: 'json' };\n`));
    ok(!hasImportAttributes(`import { with as w } from './z';\nconst assert = 1;\n`));
    // Large type-only file must stay sub-second (old Sucrase isTs path was multi-second).
    const heavy = 'export type T = ' + Array.from({ length: 200 }, (_, i) =>
        `{ a${i}: string | number | boolean | null }`).join(' | ') + ';\n';
    const t0 = Date.now();
    strictEqual(hasImportAttributes(heavy), false);
    ok(Date.now() - t0 < 200, `hasImportAttributes too slow: ${Date.now() - t0}ms`);
    const scanSrc = readFileSync(new URL('../../cts/src/scan.ts', import.meta.url), 'utf8');
    const attrBody = scanSrc.match(/export function hasImportAttributes[\s\S]*?\nexport function /)?.[0] ?? '';
    ok(attrBody.length > 100 && !attrBody.includes('parse(source'), 'hasImportAttributes must not full-parse');
});

Deno.test('ImportScanner primitive: oxc-first scan matches extractImports edges', () => {
    const oxc = tryLoadOxc();
    ok(oxc, 'oxc extension required for this gate');
    const root = makePosixTempDir('import-scanner');
    try {
        mkdirSync(root, { recursive: true });
        const file = join(root, 'mod.ts');
        const source = [
            `import type { X } from './types';`,
            `import { a } from './a.js';`,
            `export { b } from './b.js';`,
            `const r = require('./c.js');`,
        ].join('\n');
        writeFileSync(file, source);
        const scanner = new ImportScanner(oxc);
        const t0 = Date.now();
        const deps = scanner.scanFile(file).sort();
        ok(Date.now() - t0 < 500, `scanFile slow: ${Date.now() - t0}ms`);
        // type-only import may be omitted by oxc; value edges must remain.
        ok(deps.includes('./a.js'));
        ok(deps.includes('./b.js'));
        // require may or may not appear depending on oxc scan; sucrase path keeps it.
        const sucrase = extractImports(source, true).sort();
        for (const d of deps) ok(sucrase.includes(d) || d.endsWith('.js'), `unexpected dep ${d}`);
        deepStrictEqual(
            deps.filter(d => d === './a.js' || d === './b.js'),
            ['./a.js', './b.js'],
        );
    } finally {
        Deno.removeSync(root, { recursive: true });
    }
});

Deno.test('extractImports cooks string specifiers and only scans global require calls', () => {
    const escaped = String.raw`
        import '\u002e/static.js';
        export * from "\x2e/export.js";
        import('\u{2e}/dynamic.js');
        require('.\x2fcommon.cjs');
    `;
    deepStrictEqual(extractImports(escaped).sort(), [
        './common.cjs',
        './dynamic.js',
        './export.js',
        './static.js',
    ]);

    const shadowed = `
        object.require('./property.js');
        object?.require('./optional-property.js');
        function withParam(require) { require('./parameter.js'); }
        function withVar() {
            require('./function-var.js');
            var require = () => {};
        }
        {
            const require = () => {};
            require('./block.js');
        }
        require('./global.js');
    `;
    deepStrictEqual(extractImports(shadowed), ['./global.js']);

    deepStrictEqual(extractImports(`
        require('./top-level.js');
        const require = () => {};
    `), []);
    deepStrictEqual(extractImports(`
        import require from './loader.js';
        require('./local.js');
    `), ['./loader.js']);
});

Deno.test('ImportScanner strict mode preserves parse failures', () => {
    const root = makePosixTempDir('import-scanner-strict');
    try {
        const file = join(root, 'broken.ts');
        const wasmFile = join(root, 'broken.wasm');
        writeFileSync(file, 'import {');
        writeFileSync(wasmFile, Uint8Array.of(0x00, 0x61, 0x73, 0x6d, 0x01));
        const scanner = new ImportScanner(null);
        deepStrictEqual(scanner.scanFile(file), []);
        throws(() => scanner.scanFile(file, undefined, true));
        deepStrictEqual(scanner.scanFile(wasmFile), []);
        throws(() => scanner.scanFile(wasmFile, undefined, true));
        const oxc = tryLoadOxc();
        ok(oxc, 'oxc extension required for strict scan gate');
        throws(() => new ImportScanner(oxc).scanFile(file, undefined, true));
    } finally {
        Deno.removeSync(root, { recursive: true });
    }
});

Deno.test('DepScanner: full graph reports malformed source instead of caching an empty graph', async () => {
    const root = makePosixTempDir('dep-full-graph-parse');
    const main = join(root, 'main.ts');
    const cfg = createConfig({ cacheDir: join(root, 'cache'), enableOxc: false, silent: true });
    let resolver: ModuleResolver | null = null;
    try {
        writeFileSync(main, 'import {');
        resolver = new ModuleResolver(cfg, root, true);
        const result = await new DepScanner(
            resolver, cfg, null, null, null, { fullGraph: true },
        ).scan(main, main);
        strictEqual(result.errors.length, 1);
        ok((result.errors[0]?.error.length ?? 0) > 0);
    } finally {
        resolver?.lockStore.close();
        Deno.removeSync(root, { recursive: true });
    }
});

Deno.test('DepScanner: warm cache reuses imports while pack-style scans bypass them', async () => {
    const root = makePosixTempDir('dep-import-cache');
    // cts is POSIX-internally (cts/AGENT.md: "host paths on the boundary but
    // POSIX internally"), so every ModuleInfo.localPath comes back with forward
    // slashes. node:path join() yields backslashes on Windows, which made
    // `module.localPath === dep` never match AND made the custom scanner's
    // `localPath === main` never fire — so './other.ts' was never injected and
    // two of the assertions below failed for a path-shape reason, not a scanner
    // one. root is already POSIX via makePosixTempDir; keep these consistent.
    const main = `${root}/main.ts`;
    const dep = `${root}/dep.ts`;
    const other = `${root}/other.ts`;
    const config = () => createConfig({
        cacheDir: join(root, 'cache'),
        persistLock: true,
        ignoreScripts: true,
        enableOxc: false,
        silent: true,
    });
    try {
        mkdirSync(root, { recursive: true });
        writeFileSync(main, `import './dep.ts';\n`);
        writeFileSync(dep, `export const dep = 1;\n`);
        writeFileSync(other, `export const other = 1;\n`);

        const firstResolver = new ModuleResolver(config(), root, false);
        const first = await new DepScanner(firstResolver, config()).scan(main, main);
        strictEqual(first.visited, 2);
        firstResolver.flushLock();
        firstResolver.lockStore.close();

        const packResolver = new ModuleResolver(config(), root, true);
        const packLike = await new DepScanner(
            packResolver,
            config(),
            null,
            null,
            async localPath => localPath === main ? ['./other.ts'] : [],
            { fullGraph: true },
        ).scan(main, main);
        ok(packLike.modules.some(module => module.localPath === other),
            `pack-style fullGraph scan must include the injected './other.ts'; got [${packLike.modules.map(m => m.localPath).join(', ')}]`);
        ok(!packLike.modules.some(module => module.localPath === dep),
            `pack-style scan must bypass the cached import edge to dep.ts; got [${packLike.modules.map(m => m.localPath).join(', ')}]`);
        packResolver.lockStore.close();

        Deno.removeSync(main);
        Deno.removeSync(dep);
        const warmResolver = new ModuleResolver(config(), root, true);
        const warm = await new DepScanner(warmResolver, config()).scan(main, main);
        strictEqual(warm.errors.length, 0);
        ok(warm.modules.some(module => module.localPath === dep),
            `warm scan must reuse the cached import edge and re-report dep.ts after both files were deleted from disk; got [${warm.modules.map(m => m.localPath).join(', ')}]`);
        warmResolver.lockStore.close();
    } finally {
        // Exception-safe teardown: if any assertion above throws, the still-open
        // SQLite handle would make removeSync fail and mask the real error.
        // SQLite's Win32 VFS omits FILE_SHARE_DELETE, so closing is mandatory.
        try { LockStore.closeAll(); } catch {}
        Deno.removeSync(root, { recursive: true });
    }
});

Deno.test('DepScanner: worker infrastructure failure aborts instead of blaming a file', async () => {
    const root = makePosixTempDir('dep-worker-failure');
    const main = join(root, 'main.ts');
    const cfg = createConfig({ cacheDir: join(root, 'cache'), silent: true });
    let resolver: ModuleResolver | null = null;
    try {
        mkdirSync(root, { recursive: true });
        writeFileSync(main, `export const ok = true;\n`);
        resolver = new ModuleResolver(cfg, root, true);
        const scanner = new DepScanner(
            resolver,
            cfg,
            null,
            null,
            async () => { throw new ParseWorkerError('injected worker failure'); },
        );
        await rejects(
            scanner.scan(main, main),
            error => error instanceof ParseWorkerError && error.message === 'injected worker failure',
        );
    } finally {
        resolver?.lockStore.close();
        Deno.removeSync(root, { recursive: true });
    }
});
