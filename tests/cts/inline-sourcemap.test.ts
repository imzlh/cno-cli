// --enable-inline-sourcemap: an embedded sourceMappingURL in a passthrough
// module must feed the native runtime's one-shot map injection, so stack
// positions point at the original source. The frame keeps the module name;
// only the line:column is remapped.
import { ok, strictEqual } from 'node:assert';
import { join } from 'node:path';
import { withTempDir } from '../_helpers/temp.ts';

const GEN_MJS = [
    'export function boom() {',
    '  throw new Error("INLINE_MAP_BOMB");',
    '}',
    '//# sourceMappingURL=gen.mjs.map',
].join('\n');

// gen line 2, column 0 -> original line 1, column 1 (VLQ "AAAA").
const GEN_MAP = JSON.stringify({
    version: 3,
    sources: ['original.ts'],
    sourcesContent: ['// the original source\n'],
    names: [],
    mappings: ';AAAA',
});

async function runCli(args: string[], cwd: string): Promise<{ code: number; text: string }> {
    const output = await new Deno.Command(Deno.execPath(), {
        args,
        cwd,
        stdout: 'piped',
        stderr: 'piped',
    }).output();
    return {
        code: output.code,
        text: new TextDecoder().decode(output.stdout) + new TextDecoder().decode(output.stderr),
    };
}

Deno.test({ name: 'cli: --enable-inline-sourcemap remaps stacks through embedded maps', timeout: 15000 }, async () => {
    await withTempDir('inline-sourcemap', async (dir) => {
        await Deno.writeTextFile(join(dir, 'gen.mjs'), GEN_MJS);
        await Deno.writeTextFile(join(dir, 'gen.mjs.map'), GEN_MAP);
        await Deno.writeTextFile(join(dir, 'main.mjs'), 'import { boom } from "./gen.mjs";\nboom();\n');

        // Cold cache: the map is injected at compile time.
        const cold = await runCli(['run', '--enable-inline-sourcemap', 'main.mjs'], dir);
        strictEqual(cold.code, 1, cold.text);
        ok(cold.text.includes('INLINE_MAP_BOMB'), cold.text);
        ok(cold.text.includes('gen.mjs:1:1'), `expected remapped positions:\n${cold.text}`);

        // Warm runs must stay remapped: annotated modules stay out of the
        // bytecode cache so every load re-injects the map.
        const warm = await runCli(['run', '--enable-inline-sourcemap', 'main.mjs'], dir);
        strictEqual(warm.code, 1, warm.text);
        ok(warm.text.includes('gen.mjs:1:1'), `expected remapped positions on a warm run:\n${warm.text}`);

        // Default stays off: the js positions are final, no map is consulted.
        const off = await runCli(['run', 'main.mjs'], dir);
        strictEqual(off.code, 1, off.text);
        ok(off.text.includes('INLINE_MAP_BOMB'), off.text);
        ok(off.text.includes('gen.mjs:2:9'), `expected raw positions without the flag:\n${off.text}`);
    });
});

Deno.test({ name: 'cli: a missing embedded map degrades to the normal error', timeout: 15000 }, async () => {
    await withTempDir('inline-sourcemap-missing', async (dir) => {
        await Deno.writeTextFile(join(dir, 'gen.mjs'), GEN_MJS);
        // The annotation points nowhere; the run must behave exactly as if the
        // annotation were absent.
        await Deno.writeTextFile(join(dir, 'main.mjs'), 'import { boom } from "./gen.mjs";\nboom();\n');

        const out = await runCli(['run', '--enable-inline-sourcemap', 'main.mjs'], dir);
        strictEqual(out.code, 1, out.text);
        ok(out.text.includes('INLINE_MAP_BOMB'), out.text);
        ok(out.text.includes('gen.mjs:2:9'), out.text);
    });
});

const GEN_CJS = [
    'function boom() {',
    '  throw new Error("INLINE_MAP_BOMB");',
    '}',
    'exports.boom = boom;',
    '//# sourceMappingURL=gen.cjs.map',
].join('\n');

Deno.test({ name: 'cli: CJS modules remap on cold and warm runs', timeout: 20000 }, async () => {
    await withTempDir('inline-sourcemap-cjs', async (dir) => {
        await Deno.writeTextFile(join(dir, 'gen.cjs'), GEN_CJS);
        await Deno.writeTextFile(join(dir, 'gen.cjs.map'), GEN_MAP);
        await Deno.writeTextFile(join(dir, 'main.cjs'), 'const { boom } = require("./gen.cjs");\nboom();\n');

        const cold = await runCli(['run', '--enable-inline-sourcemap', 'main.cjs'], dir);
        strictEqual(cold.code, 1, cold.text);
        ok(cold.text.includes('gen.cjs:1:1'), `expected remapped CJS positions:\n${cold.text}`);

        // The annotated module must stay out of the CJS bytecode cache.
        const warm = await runCli(['run', '--enable-inline-sourcemap', 'main.cjs'], dir);
        strictEqual(warm.code, 1, warm.text);
        ok(warm.text.includes('gen.cjs:1:1'), `expected remapped CJS positions on a warm run:\n${warm.text}`);
    });
});

Deno.test({ name: 'cli: precache must not persist annotated modules as bytecode', timeout: 20000 }, async () => {
    await withTempDir('inline-sourcemap-precache', async (dir) => {
        await Deno.writeTextFile(join(dir, 'gen.mjs'), GEN_MJS);
        await Deno.writeTextFile(join(dir, 'gen.mjs.map'), GEN_MAP);
        await Deno.writeTextFile(join(dir, 'main.mjs'), 'import { boom } from "./gen.mjs";\nboom();\n');

        // The same invocation compiles the graph and then loads it; the
        // annotated module must not enter the bytecode cache in between.
        const first = await runCli(['run', '--precache', '--enable-inline-sourcemap', 'main.mjs'], dir);
        strictEqual(first.code, 1, first.text);
        ok(first.text.includes('gen.mjs:1:1'), `expected remapped positions with --precache:\n${first.text}`);

        const warm = await runCli(['run', '--enable-inline-sourcemap', 'main.mjs'], dir);
        strictEqual(warm.code, 1, warm.text);
        ok(warm.text.includes('gen.mjs:1:1'), `expected remapped positions after precache:\n${warm.text}`);
    });
});

Deno.test({ name: 'cli: inline precompile (no workers) also skips annotated modules', timeout: 20000 }, async () => {
    await withTempDir('inline-sourcemap-no-workers', async (dir) => {
        await Deno.writeTextFile(join(dir, 'gen.mjs'), GEN_MJS);
        await Deno.writeTextFile(join(dir, 'gen.mjs.map'), GEN_MAP);
        await Deno.writeTextFile(join(dir, 'main.mjs'), 'import { boom } from "./gen.mjs";\nboom();\n');

        // CTS_WORKERS=0 forces compileModulesInline, the single-threaded
        // precompile path that must honor the same annotation gate.
        const output = await new Deno.Command(Deno.execPath(), {
            args: ['run', '--precache', '--enable-inline-sourcemap', 'main.mjs'],
            cwd: dir,
            stdout: 'piped',
            stderr: 'piped',
            env: { ...Deno.env.toObject(), CTS_WORKERS: '0' },
        }).output();
        const text = new TextDecoder().decode(output.stdout) + new TextDecoder().decode(output.stderr);
        strictEqual(output.code, 1, text);
        ok(text.includes('gen.mjs:1:1'), `expected remapped positions on the inline precompile path:\n${text}`);
    });
});

Deno.test({ name: 'cli: data URI annotations are skipped, not fatal', timeout: 15000 }, async () => {
    await withTempDir('inline-sourcemap-data', async (dir) => {
        const genData = GEN_MJS.replace('//# sourceMappingURL=gen.mjs.map',
            '//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozfQ==');
        await Deno.writeTextFile(join(dir, 'gen.mjs'), genData);
        await Deno.writeTextFile(join(dir, 'main.mjs'), 'import { boom } from "./gen.mjs";\nboom();\n');

        const out = await runCli(['run', '--enable-inline-sourcemap', 'main.mjs'], dir);
        strictEqual(out.code, 1, out.text);
        ok(out.text.includes('INLINE_MAP_BOMB'), out.text);
        ok(out.text.includes('gen.mjs:2:9'), `data URI maps are skipped, positions stay raw:\n${out.text}`);
    });
});
