import { strictEqual, throws } from 'node:assert';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { makePosixTempDir } from '../_helpers/temp.ts';
import { clearResolveCache, resolveFile } from '../../cts/src/utils/io.ts';
import { toPosixPath } from '../../cts/src/utils/path.ts';
import { createConfig } from '../../cts/src/config.ts';
import { ModuleResolver } from '../../cts/src/resolve/index.ts';

function tree(root: string, files: Record<string, string>): void {
    for (const [rel, body] of Object.entries(files)) {
        const p = join(root, rel);
        mkdirSync(join(p, '..'), { recursive: true });
        writeFileSync(p, body);
    }
}

// Node's LOAD_AS_FILE completes before LOAD_AS_DIRECTORY. Verified against
// `node -e "require.resolve('./x')"` on the same fixture shape: Node picks
// x.js, not x/index.js.
Deno.test('cts resolveFile: a real file beats a same-named directory index', () => {
    const root = makePosixTempDir('resolve-file-order');
    try {
        tree(root, {
            'x.js': 'module.exports = "FILE";\n',
            'x/index.js': 'module.exports = "DIR";\n',
        });
        clearResolveCache();
        strictEqual(resolveFile(toPosixPath(join(root, 'x'))), toPosixPath(join(root, 'x.js')));
    } finally {
        clearResolveCache();
        rmSync(root, { recursive: true, force: true });
    }
});

Deno.test('cts resolveFile: extension order is honored among files', () => {
    const root = makePosixTempDir('resolve-file-extorder');
    try {
        // EXTS order is ['.ts', '.tsx', '.js', ...] — .ts must win over .js.
        tree(root, { 'y.ts': 'export const v = 1;\n', 'y.js': 'module.exports = 1;\n' });
        clearResolveCache();
        strictEqual(resolveFile(toPosixPath(join(root, 'y'))), toPosixPath(join(root, 'y.ts')));
    } finally {
        clearResolveCache();
        rmSync(root, { recursive: true, force: true });
    }
});

Deno.test('cts resolveFile: directory index still resolves when no file matches', () => {
    const root = makePosixTempDir('resolve-file-dironly');
    try {
        tree(root, { 'z/index.js': 'module.exports = "DIR";\n' });
        clearResolveCache();
        strictEqual(resolveFile(toPosixPath(join(root, 'z'))), toPosixPath(join(root, 'z/index.js')));
    } finally {
        clearResolveCache();
        rmSync(root, { recursive: true, force: true });
    }
});

// `foo.js` as a DIRECTORY name with an index inside (es5-ext and friends ship
// dirs whose names carry extensions). The extension loop must still find it.
Deno.test('cts resolveFile: extension-named directory index resolves', () => {
    const root = makePosixTempDir('resolve-file-extdir');
    try {
        tree(root, { 'w.js/index.js': 'module.exports = "EXTDIR";\n' });
        clearResolveCache();
        strictEqual(resolveFile(toPosixPath(join(root, 'w'))), toPosixPath(join(root, 'w.js/index.js')));
    } finally {
        clearResolveCache();
        rmSync(root, { recursive: true, force: true });
    }
});

Deno.test('cts resolveFile: unresolvable base still throws', () => {
    const root = makePosixTempDir('resolve-file-miss');
    try {
        clearResolveCache();
        throws(() => resolveFile(toPosixPath(join(root, 'nope'))), /Cannot resolve/);
    } finally {
        clearResolveCache();
        rmSync(root, { recursive: true, force: true });
    }
});

Deno.test('cts resolver: local ESM paths reject encoded separators and dot traversal', () => {
    const root = makePosixTempDir('resolve-encoded-path');
    const entry = toPosixPath(join(root, 'entry.mjs'));
    let resolver: ModuleResolver | null = null;
    try {
        tree(root, {
            'entry.mjs': 'export {}\n',
            'dir/secret.mjs': 'export const value = 1\n',
            'outside.mjs': 'export const value = 2\n',
            'with space.mjs': 'export const value = 3\n',
            'literal%name.mjs': 'export const value = 4\n',
        });
        resolver = new ModuleResolver(createConfig({
            cacheDir: toPosixPath(join(root, 'cache')),
            disableLock: true,
        }), root, true);

        for (const spec of ['./dir%2Fsecret.mjs', './dir%5Csecret.mjs', './%2e%2e/outside.mjs']) {
            let caught: unknown;
            try {
                resolver.resolve(spec, entry);
            } catch (e) {
                caught = e;
            }
            strictEqual((caught as { code?: string } | undefined)?.code,
                'ERR_INVALID_MODULE_SPECIFIER', `must reject ${spec}`);
        }

        strictEqual(resolver.resolve('./with%20space.mjs', entry).localPath,
            toPosixPath(join(root, 'with space.mjs')),
            'encoded spaces remain valid local URL paths');
        strictEqual(resolver.resolve('./literal%name.mjs', entry).localPath,
            toPosixPath(join(root, 'literal%name.mjs')),
            'a literal percent filename still wins when decoding is invalid');
    } finally {
        resolver?.close();
        clearResolveCache();
        rmSync(root, { recursive: true, force: true });
    }
});

Deno.test('cts resolver: explicit local extensions follow Bun source fallbacks', () => {
    const root = makePosixTempDir('resolve-explicit-extension');
    const entry = toPosixPath(join(root, 'entry.mjs'));
    let resolver: ModuleResolver | null = null;
    try {
        tree(root, {
            'entry.mjs': 'export {}\n',
            'typed.ts': 'export const value = 1\n',
            'view.tsx': 'export const value = 3\n',
            'preferred.js': 'export const value = 4\n',
            'preferred.ts': 'export const value = 5\n',
            'preferred.tsx': 'export const value = 6\n',
            'both.ts': 'export const value = 7\n',
            'both.tsx': 'export const value = 8\n',
            'module.mts': 'export const value = 6\n',
            'legacy.cts': 'export const value = 7\n',
            'preferred.mjs': 'export const value = 8\n',
            'preferred.mts': 'export const value = 9\n',
            'preferred.cjs': 'module.exports = 10\n',
            'preferred.cts': 'module.exports = 11\n',
            'node_modules/pkg/package.json': '{"name":"pkg","version":"1.0.0"}\n',
            'node_modules/pkg/entry.mts': 'export const value = 8\n',
            'node_modules/pkg/script.ts': 'export const value = 9\n',
            'node_modules/pkg/view.tsx': 'export const value = 10\n',
            'node_modules/pkg/legacy.cts': 'export const value = 11\n',
        });
        resolver = new ModuleResolver(createConfig({
            cacheDir: toPosixPath(join(root, 'cache')),
            disableLock: true,
        }), root, true);

        strictEqual(resolver.resolve('./typed.js', entry).localPath, toPosixPath(join(root, 'typed.ts')));
        strictEqual(resolver.resolve('./view.js', entry).localPath, toPosixPath(join(root, 'view.tsx')));
        strictEqual(resolver.resolve('./view.jsx', entry).localPath, toPosixPath(join(root, 'view.tsx')));
        strictEqual(resolver.resolve('./preferred.js', entry).localPath, toPosixPath(join(root, 'preferred.js')));
        strictEqual(resolver.resolve('./preferred.jsx', entry).localPath, toPosixPath(join(root, 'preferred.ts')));
        strictEqual(resolver.resolve('./both.js', entry).localPath, toPosixPath(join(root, 'both.ts')));
        strictEqual(resolver.resolve('./both.jsx', entry).localPath, toPosixPath(join(root, 'both.ts')));
        strictEqual(resolver.resolve('./module.mjs', entry).localPath, toPosixPath(join(root, 'module.mts')));
        strictEqual(resolver.resolve('./legacy.cjs', entry).localPath, toPosixPath(join(root, 'legacy.cts')));
        strictEqual(resolver.resolve('./preferred.mjs', entry).localPath, toPosixPath(join(root, 'preferred.mjs')));
        strictEqual(resolver.resolve('./preferred.cjs', entry).localPath, toPosixPath(join(root, 'preferred.cjs')));
        strictEqual(resolver.resolve('./node_modules/pkg/script.js', entry).localPath,
            toPosixPath(join(root, 'node_modules/pkg/script.ts')));
        strictEqual(resolver.resolve('./node_modules/pkg/view.jsx', entry).localPath,
            toPosixPath(join(root, 'node_modules/pkg/view.tsx')));
        throws(() => resolver?.resolve('./node_modules/pkg/entry.mjs', entry), /Cannot resolve/);
        throws(() => resolver?.resolve('./node_modules/pkg/legacy.cjs', entry), /Cannot resolve/);
    } finally {
        resolver?.close();
        clearResolveCache();
        rmSync(root, { recursive: true, force: true });
    }
});
