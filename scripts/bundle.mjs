#!/usr/bin/env node
/**
 * esbuild driver for cno-cli bundles.
 *
 * Modes:
 *   release  → dist/cno-cli.js     (symbol mode: no `import.meta.*` in output)
 *   dev      → dist/cno-cli.js     (keeps `import.meta.*`, inline sourcemap, for
 *                                    running the bundled JS in a normal-mode cjs)
 *   min      → dist/cno-cli.min.js (release + esbuild minify)
 *
 * Symbol-mode transform:
 *   - --define rewrites every AST occurrence of `import.meta.use` and
 *     `import.meta.register` to a top-level identifier (AST-aware, so no
 *     false hits inside string literals).
 *   - A banner binds those identifiers to the well-known global symbols
 *     that circu.js exposes when CJS__DISABLE_MODULE_USE is on
 *     (i.e. CJS_USE_SYMBOL_INTERNAL=ON, our release flavour).
 *   - `import.meta.dirname` (a dev-only fallback path in bootstrap.ts) is
 *     defined to `undefined` so it disappears from the bundle too.
 *
 * After this, the bundle contains no `import.meta.*` references and can
 * be fed to cjsc for self-attach into a release cno binary.
 */
import { build } from 'esbuild';
import { argv, exit } from 'node:process';
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

const mode = argv[2] || 'release';

const SYMBOL_DEFINES = {
    'import.meta.use':      '__cno_use__',
    'import.meta.register': '__cno_register__',
    'import.meta.dirname':  'undefined',
};
const SYMBOL_BANNER = {
    js:
        'const __cno_use__=globalThis[Symbol.for("cjs.internal.use")],' +
        '__cno_register__=globalThis[Symbol.for("cjs.internal.register")];',
};

/**
 * @type { import('esbuild').BuildOptions }
 */
const common = {
    entryPoints:        ['src/main.ts'],
    bundle:             true,
    format:             'esm',
    platform:           'node',
    target:             'es2024',
    loader:             { '.json': 'json' },
    keepNames:          true
};

let opts;
switch (mode) {
    case 'dev':
        opts = { outfile: 'dist/cno-cli.js', sourcemap: 'inline' };
        break;
    case 'min':
        opts = { outfile: 'dist/cno-cli.min.js', minify: true,
                 define: SYMBOL_DEFINES, banner: SYMBOL_BANNER };
        break;
    case 'release':
        opts = { outfile: 'dist/cno-cli.js',
                 define: SYMBOL_DEFINES, banner: SYMBOL_BANNER };
        break;
    default:
        console.error(`Unknown bundle mode: ${mode}`);
        exit(1);
}

mkdirSync(dirname(opts.outfile), { recursive: true });
await build({ ...common, ...opts });
console.log(`bundle [${mode}] → ${opts.outfile}`);
