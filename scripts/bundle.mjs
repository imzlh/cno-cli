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
import { argv, env, exit } from 'node:process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

const mode = argv[2] || 'release';
const BUN_INJECTOR = resolve(__dirname, '../cno/src/bun/_internal/inject.ts');

// The Node compatibility sources must match the cno checkout bundled below.
// Archive builds can supply the original commit explicitly when Git is absent.
let polyfillRevision = env.CNO_POLYFILL_REVISION;
if (polyfillRevision === undefined) {
    const cnoDir = resolve(__dirname, '../cno');
    if (!existsSync(resolve(cnoDir, '.git'))) {
        throw new Error('Cannot identify the cno revision: initialize the cno submodule or set CNO_POLYFILL_REVISION to its full commit SHA');
    }
    polyfillRevision = execFileSync('git', ['-C', cnoDir, 'rev-parse', '--verify', 'HEAD'], { encoding: 'utf8' }).trim();
}
if (!/^[0-9a-f]{40}$/i.test(polyfillRevision)) {
    throw new Error('CNO_POLYFILL_REVISION must be a full 40-character Git commit SHA');
}
polyfillRevision = polyfillRevision.toLowerCase();
const REVISION_DEFINES = { '__CNO_POLYFILL_REVISION__': JSON.stringify(polyfillRevision) };

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
    keepNames:          true,
    metafile:           true,
    plugins: [{
        name: 'no-embedded-bun-implementation',
        setup(builder) {
            // The injector is the only Bun file the CLI bundle may contain. It
            // resolves setup-installed TypeScript through CTS on first access.
            builder.onLoad({ filter: /[/\\]cno[/\\]src[/\\]bun[/\\]/ }, ({ path }) => {
                if (resolve(path) === BUN_INJECTOR) return null;
                return { errors: [{ text: `Bun implementation cannot enter the embedded CLI bundle: ${path}` }] };
            });
        },
    }],
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

// Tests redirect the output so they do not replace the dist/ artifacts.
if (env.CNO_BUNDLE_OUTFILE) opts.outfile = env.CNO_BUNDLE_OUTFILE;
mkdirSync(dirname(opts.outfile), { recursive: true });
const result = await build({ ...common, ...opts, define: { ...REVISION_DEFINES, ...opts.define } });
const bunInputs = Object.keys(result.metafile.inputs)
    .filter((input) => /(^|\/)cno\/src\/bun\//.test(input.replaceAll('\\', '/')));
if (bunInputs.length !== 1 || resolve(bunInputs[0]) !== BUN_INJECTOR) {
    throw new Error(`Embedded CLI bundle has unexpected Bun inputs: ${bunInputs.join(', ') || '<none>'}`);
}
// Tests inspect the exact input graph through this optional artifact.
if (env.CNO_BUNDLE_METAFILE) {
    writeFileSync(env.CNO_BUNDLE_METAFILE, JSON.stringify(result.metafile));
}
console.log(`bundle [${mode}] → ${opts.outfile}`);
console.log(`Node polyfill revision: ${polyfillRevision}`);
