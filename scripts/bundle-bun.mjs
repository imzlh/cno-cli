#!/usr/bin/env node
// Optional runtime payloads, never inputs to the embedded CLI bytecode blob.
import { build } from 'esbuild';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const repository = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const bundledNodeModules = new Map([
    ['node:fs', resolve(repository, 'cno/src/node/fs/mod.ts')],
    ['node:path', resolve(repository, 'cno/src/node/path/index.ts')],
]);
const forbiddenPayloadInputs = [
    'cno/src/bun/_internal/',
    'cno/src/webapi/formdata.ts',
    'cno/src/main.ts',
];

export async function buildBunPayload({ mode = 'release', outdir = 'dist/lib/cno/bun' } = {}) {
    if (mode !== 'release' && mode !== 'min') {
        throw new Error(`Unknown Bun payload mode: ${mode}`);
    }
    const result = await build({
        absWorkingDir: repository,
        entryPoints: {
            index: 'cno/src/bun/index.ts',
            sqlite: 'cno/src/bun/sqlite/index.ts',
        },
        outdir: resolve(repository, outdir),
        bundle: true,
        // No shared chunks or external source imports: payloads must survive
        // relocation without a checkout, including their Node/shared helpers.
        splitting: false,
        format: 'esm',
        platform: 'node',
        target: 'es2024',
        keepNames: true,
        minify: mode === 'min',
        metafile: true,
        define: {
            'import.meta.use': '__cno_use__',
            'import.meta.register': '__cno_register__',
            'import.meta.dirname': 'undefined',
        },
        banner: {
            js: 'const __cno_use__=globalThis[Symbol.for("cjs.internal.use")],'
                + '__cno_register__=globalThis[Symbol.for("cjs.internal.register")];',
        },
        plugins: [{
            name: 'self-contained-bun-payload',
            setup(builder) {
                // Bun helpers must also work under --no-node. Bundle the small
                // set of shared Node-compatible primitives they use instead of
                // leaving node:* imports for CTS to resolve at runtime.
                builder.onResolve({ filter: /^node:/ }, ({ path }) => {
                    const target = bundledNodeModules.get(path);
                    return target
                        ? { path: target }
                        : { errors: [{ text: `Bun payload cannot depend on external module ${path}` }] };
                });
                builder.onEnd(({ metafile }) => {
                    const inputs = Object.keys(metafile?.inputs ?? {})
                        .map(path => path.replaceAll('\\', '/'));
                    for (const forbidden of forbiddenPayloadInputs) {
                        const input = inputs.find(path => path.includes(forbidden));
                        if (input) throw new Error(`Bun payload has a forbidden bootstrap/global input: ${input}`);
                    }
                    for (const [path, output] of Object.entries(metafile?.outputs ?? {})) {
                        if (output.imports.length) {
                            throw new Error(`Bun payload ${path} has unbundled imports`);
                        }
                    }
                });
            },
        }],
    });
    return result;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    const mode = process.argv[2] || 'release';
    await buildBunPayload({ mode });
    console.log(`Bun payload [${mode}] -> dist/lib/cno/bun/{index,sqlite}.js`);
}
