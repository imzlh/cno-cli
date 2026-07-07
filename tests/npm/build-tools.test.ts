import { ok } from 'node:assert';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

function makeTempDir(name: string): string {
    return Deno.makeTempDirSync({ prefix: `cno-${name}-` });
}

Deno.test({ name: 'rollup: bundles virtual ESM modules', timeout: 30000 }, async () => {
    const { rollup } = await import('npm:rollup');
    const bundle = await rollup({
        input: 'entry',
        plugins: [{
            name: 'cno-virtual',
            resolveId(id: string) {
                return id === 'entry' || id === 'dep' ? id : null;
            },
            load(id: string) {
                if (id === 'entry') return 'import { answer } from "dep"; export default answer + 1;';
                if (id === 'dep') return 'export const answer = 41;';
                return null;
            },
        }],
    });

    try {
        const generated = await bundle.generate({ format: 'esm' });
        const code = generated.output[0]?.code ?? '';
        ok(code.includes('const answer = 41'), `generated bundle should include virtual dependency: ${code}`);
        ok(code.includes('answer + 1'), `generated bundle should include entry expression: ${code}`);
    } finally {
        await bundle.close();
    }
});

Deno.test({ name: 'rollup: reads entry graph from disk and writes bundle output', timeout: 30000 }, async () => {
    const root = makeTempDir('rollup-disk');
    try {
        const srcDir = join(root, 'src');
        const outFile = join(root, 'dist', 'bundle.cjs');
        mkdirSync(srcDir, { recursive: true });
        mkdirSync(join(root, 'dist'), { recursive: true });
        writeFileSync(join(srcDir, 'dep.js'), 'export const answer = 40 + 2;\n');
        writeFileSync(join(srcDir, 'entry.js'), 'import { answer } from "./dep.js"; export default answer;\n');

        const { rollup } = await import('npm:rollup');
        const bundle = await rollup({ input: join(srcDir, 'entry.js') });
        try {
            await bundle.write({ file: outFile, format: 'cjs', exports: 'auto' });
        } finally {
            await bundle.close();
        }
        const output = readFileSync(outFile, 'utf8');
        ok(output.includes('40 + 2'), `bundle should include dependency code: ${output}`);
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
});

Deno.test({ name: 'postcss: processes a plugin pipeline', timeout: 30000 }, async () => {
    const mod = await import('npm:postcss');
    const postcss = mod.default ?? mod;
    const plugin = {
        postcssPlugin: 'cno-compat-plugin',
        Declaration(decl: any) {
            if (decl.prop === 'color') decl.value = 'blue';
        },
    };
    const result = await postcss([plugin]).process('.a{color:red}', { from: undefined });
    ok(result.css.includes('color:blue'), `unexpected css: ${result.css}`);
});

Deno.test({ name: 'esbuild: transforms TypeScript through platform binary package', timeout: 30000 }, async () => {
    const esbuild = await import('npm:esbuild');
    const result = await esbuild.transform('const value: number = 1;', {
        loader: 'ts',
        format: 'esm',
    });
    ok(result.code.includes('const value = 1'), `unexpected transform output: ${result.code}`);
    await esbuild.stop?.();
});

Deno.test({ name: 'esbuild: bundles disk entry through platform binary package', timeout: 30000 }, async () => {
    const root = makeTempDir('esbuild-disk');
    try {
        const srcDir = join(root, 'src');
        const outFile = join(root, 'out', 'bundle.js');
        mkdirSync(srcDir, { recursive: true });
        mkdirSync(join(root, 'out'), { recursive: true });
        writeFileSync(join(srcDir, 'dep.ts'), 'export const value: number = 7;\n');
        writeFileSync(join(srcDir, 'entry.ts'), 'import { value } from "./dep"; console.log(value * 6);\n');

        const esbuild = await import('npm:esbuild');
        await esbuild.build({
            entryPoints: [join(srcDir, 'entry.ts')],
            bundle: true,
            outfile: outFile,
            platform: 'node',
            format: 'cjs',
            logLevel: 'silent',
        });
        const output = readFileSync(outFile, 'utf8');
        ok(output.includes('value * 6'), `bundle should include entry expression: ${output}`);
        await esbuild.stop?.();
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
});
