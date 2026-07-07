import { deepStrictEqual, strictEqual } from 'node:assert';
import { join } from 'node:path';
import { withTempDir } from '../_helpers/temp.ts';

Deno.test({ name: 'glob and fast-glob: match files from disk', timeout: 30000 }, async () => {
    const globMod = await import('npm:glob');
    const fastGlobMod = await import('npm:fast-glob');
    const fastGlob = fastGlobMod.default ?? fastGlobMod;

    await withTempDir('npm-glob', async (dir) => {
        Deno.mkdirSync(join(dir, 'src', 'nested'), { recursive: true });
        Deno.writeTextFileSync(join(dir, 'src', 'a.ts'), 'export const a = 1;');
        Deno.writeTextFileSync(join(dir, 'src', 'nested', 'b.ts'), 'export const b = 1;');
        Deno.writeTextFileSync(join(dir, 'src', 'ignore.js'), 'module.exports = 1;');

        const globbed = await globMod.glob('src/**/*.ts', { cwd: dir, posix: true });
        const fastGlobbed = await fastGlob('src/**/*.ts', { cwd: dir });

        deepStrictEqual(globbed.sort(), ['src/a.ts', 'src/nested/b.ts']);
        deepStrictEqual(fastGlobbed.sort(), ['src/a.ts', 'src/nested/b.ts']);
    });
});

Deno.test({ name: 'glob and fast-glob: honor cwd ignore and dotfile options', timeout: 30000 }, async () => {
    const globMod = await import('npm:glob');
    const fastGlobMod = await import('npm:fast-glob');
    const fastGlob = fastGlobMod.default ?? fastGlobMod;

    await withTempDir('npm-glob-ignore', async (dir) => {
        Deno.mkdirSync(join(dir, 'src', 'nested'), { recursive: true });
        Deno.writeTextFileSync(join(dir, 'src', 'keep.ts'), 'export const keep = true;');
        Deno.writeTextFileSync(join(dir, 'src', '.hidden.ts'), 'export const hidden = true;');
        Deno.writeTextFileSync(join(dir, 'src', 'nested', 'skip.test.ts'), 'export const skip = true;');

        const globbed = await globMod.glob('src/**/*.ts', {
            cwd: dir,
            dot: true,
            ignore: ['**/*.test.ts'],
            posix: true,
        });
        const fastGlobbed = await fastGlob('src/**/*.ts', {
            cwd: dir,
            dot: true,
            ignore: ['**/*.test.ts'],
        });

        deepStrictEqual(globbed.sort(), ['src/.hidden.ts', 'src/keep.ts']);
        deepStrictEqual(fastGlobbed.sort(), ['src/.hidden.ts', 'src/keep.ts']);
    });
});

Deno.test({ name: 'minimatch picomatch and pathe: match and normalize paths', timeout: 30000 }, async () => {
    const minimatchMod = await import('npm:minimatch');
    const picomatchMod = await import('npm:picomatch');
    const pathe = await import('npm:pathe');
    const minimatch = minimatchMod.minimatch ?? minimatchMod.default ?? minimatchMod;
    const picomatch = picomatchMod.default ?? picomatchMod;

    strictEqual(minimatch('src/nested/file.ts', 'src/**/*.ts'), true);
    strictEqual(picomatch('src/**/*.ts')('src/nested/file.js'), false);
    strictEqual(pathe.normalize('/tmp/demo/../file.ts'), '/tmp/file.ts');
});
