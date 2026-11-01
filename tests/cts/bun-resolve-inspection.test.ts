import { strictEqual, throws } from 'node:assert';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createConfig } from '../../cts/src/config.ts';
import { ModuleResolver } from '../../cts/src/resolve/index.ts';

Deno.test('Bun ESM inspection conditions are local and never poison ordinary resolution', () => {
    const root = mkdtempSync(join(tmpdir(), 'cts-bun-inspect-'));
    const pkg = join(root, 'node_modules', 'example');
    mkdirSync(pkg, { recursive: true });
    writeFileSync(join(pkg, 'package.json'), JSON.stringify({ name: 'example', version: '1.0.0', exports: { bun: './bun.js', import: './import.js', require: './require.cjs' }, imports: { '#entry': { bun: './bun.js', import: './import.js' } } }));
    for (const name of ['bun.js', 'import.js', 'require.cjs']) writeFileSync(join(pkg, name), '');
    const cfg = createConfig({ cacheDir: join(root, 'cache'), disableLock: true, silent: true, cachedOnly: true });
    const resolver = new ModuleResolver(cfg, root);
    const parent = join(root, 'main.js');
    try {
        strictEqual(resolver.resolveForInspection('example', parent, { bunConditions: true }).localPath, join(pkg, 'bun.js'));
        strictEqual(resolver.resolve('example', parent).localPath, join(pkg, 'import.js'));
        strictEqual(resolver.resolveForInspection('example', parent, { cjs: true }).localPath, join(pkg, 'require.cjs'));
        strictEqual(resolver.resolve('#entry', join(pkg, 'main.js')).localPath, join(pkg, 'import.js'));
        strictEqual(resolver.resolveForInspection('#entry', join(pkg, 'main.js'), { bunConditions: true }).localPath, join(pkg, 'bun.js'));
        throws(() => resolver.resolveForInspection('definitely-not-a-real-package-7253', parent, { bunConditions: true }));
        strictEqual(cfg.conditions?.includes('bun') ?? false, false);
    } finally {
        resolver.close();
        rmSync(root, { recursive: true, force: true });
    }
});
