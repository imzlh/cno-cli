import { ok, strictEqual } from 'node:assert';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

function makeTempDir(name: string): string {
    return Deno.makeTempDirSync({ prefix: `cno-${name}-` });
}

Deno.test({ name: 'less: renders nested rules and variables', timeout: 30000 }, async () => {
    const mod = await import('npm:less');
    const less = mod.default ?? mod;
    const result = await less.render('@color: red; .a { .b { color: @color; } }', { compress: true });
    strictEqual(result.css.trim(), '.a .b{color:red}');
});

Deno.test({ name: 'less: resolves disk imports from filename', timeout: 60000 }, async () => {
    const root = makeTempDir('less-import');
    try {
        const entry = join(root, 'entry.less');
        writeFileSync(join(root, 'vars.less'), '@color: #123456;\n');
        writeFileSync(entry, '@import "./vars.less"; .a { color: @color; }\n');

        const mod = await import('npm:less');
        const less = mod.default ?? mod;
        const result = await less.render('@import "./vars.less"; .a { color: @color; }', {
            filename: entry,
            compress: true,
        });
        strictEqual(result.css.trim(), '.a{color:#123456}');
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
});

Deno.test({ name: 'stylus: renders variables and nested rules', timeout: 30000 }, async () => {
    const mod = await import('npm:stylus');
    const stylus = mod.default ?? mod;
    const css = await new Promise<string>((resolve, reject) => {
        stylus.render('color = #f00\n.a\n  .b\n    color color', (error: Error | null, output: string) => {
            if (error) reject(error);
            else resolve(output);
        });
    });
    ok(css.includes('.a .b'));
    ok(css.includes('color: #f00'));
});

Deno.test({ name: 'stylus: resolves disk imports through paths option', timeout: 30000 }, async () => {
    const root = makeTempDir('stylus-import');
    try {
        const entry = join(root, 'entry.styl');
        writeFileSync(join(root, 'vars.styl'), 'color = #123456\n');
        writeFileSync(entry, '@import "vars"\n.a\n  color color\n');

        const mod = await import('npm:stylus');
        const stylus = mod.default ?? mod;
        const css = await new Promise<string>((resolve, reject) => {
            stylus.render('@import "vars"\n.a\n  color color\n', {
                filename: entry,
                paths: [root],
            }, (error: Error | null, output: string) => {
                if (error) reject(error);
                else resolve(output);
            });
        });
        ok(css.includes('color: #123456'));
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
});

Deno.test({ name: 'sass: compiles SCSS with variables', timeout: 30000 }, async () => {
    const sass = await import('npm:sass');
    const result = sass.compileString('$color: red; .a { color: $color; }', { style: 'compressed' });
    strictEqual(result.css.trim(), '.a{color:red}');
});

Deno.test({ name: 'sass: compiles disk entry with @use dependency', timeout: 30000 }, async () => {
    const root = makeTempDir('sass-import');
    try {
        const entry = join(root, 'entry.scss');
        writeFileSync(join(root, '_vars.scss'), '$color: #123456;\n');
        writeFileSync(entry, '@use "vars"; .a { color: vars.$color; }\n');

        const sass = await import('npm:sass');
        const result = sass.compile(entry, { style: 'compressed', loadPaths: [root] });
        strictEqual(result.css.trim(), '.a{color:#123456}');
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
});

Deno.test({ name: 'terser: minifies modern JavaScript', timeout: 30000 }, async () => {
    const terser = await import('npm:terser');
    const result = await terser.minify('function add(a, b) { return a + b; } console.log(add(1, 2));');
    ok(result.code?.includes('function add'));
    ok(result.code?.includes('console.log'));
});

Deno.test({ name: 'magic-string: overwrites and emits source map', timeout: 30000 }, async () => {
    const mod = await import('npm:magic-string');
    const MagicString = mod.default ?? mod.MagicString;
    const source = new MagicString('const answer = 41;');
    source.overwrite(15, 17, '42');
    strictEqual(source.toString(), 'const answer = 42;');
    ok(source.generateMap({ hires: true }).toString().includes('mappings'));
});

Deno.test({ name: 'acorn and estree-walker: parse and walk AST', timeout: 30000 }, async () => {
    const acorn = await import('npm:acorn');
    const walker = await import('npm:estree-walker');
    const ast = acorn.parse('const value = 1 + 2;', { ecmaVersion: 'latest', sourceType: 'module' }) as any;
    const seen: string[] = [];
    walker.walk(ast, {
        enter(node: any) {
            if (node.type) seen.push(node.type);
        },
    });
    ok(seen.includes('VariableDeclaration'));
    ok(seen.includes('BinaryExpression'));
});
