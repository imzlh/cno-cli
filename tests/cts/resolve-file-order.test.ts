import { strictEqual, throws } from 'node:assert';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { makePosixTempDir } from '../_helpers/temp.ts';
import { clearResolveCache, resolveFile } from '../../cts/src/utils/io.ts';
import { toPosixPath } from '../../cts/src/utils/path.ts';

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
