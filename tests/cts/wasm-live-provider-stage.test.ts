import { deepStrictEqual, ok, strictEqual } from 'node:assert';
import { join } from 'node:path';
import { withTempDir } from '../_helpers/temp.ts';
import { runCno, ADD_WASM } from '../_helpers/cli-stage-run.ts';

/*
 * (module
 *   (type (func (param i32 i32) (result i32)))
 *   (import MODULE_NAME "add" (func (type 0)))
 *   (func (export "run") (param i32 i32) (result i32)
 *     local.get 0 local.get 1 call 0))
 */
function consumerWasm(moduleName: string): Uint8Array {
    const moduleBytes = new TextEncoder().encode(moduleName);
    if (moduleBytes.byteLength > 119) throw new RangeError('test module name is too long');
    return Uint8Array.from([
        0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00,
        0x01, 0x07, 0x01, 0x60, 0x02, 0x7f, 0x7f, 0x01, 0x7f,
        0x02, moduleBytes.byteLength + 8, 0x01, moduleBytes.byteLength, ...moduleBytes,
        0x03, 0x61, 0x64, 0x64, 0x00, 0x00,
        0x03, 0x02, 0x01, 0x00,
        0x07, 0x07, 0x01, 0x03, 0x72, 0x75, 0x6e, 0x00, 0x01,
        0x0a, 0x0a, 0x01, 0x08, 0x00, 0x20, 0x00, 0x20, 0x01, 0x10, 0x00, 0x0b,
    ]);
}

interface Probe {
    value: number;
    same: boolean;
    providerSymbols: number;
    glueSymbols: number;
    providerSource: string;
    glueSource: string;
}

function parseProbe(stdout: string): Probe {
    const line = stdout.trim().split(/\r?\n/).find(candidate => candidate.startsWith('WASM_PROVIDER:'));
    ok(line, `missing WASM_PROVIDER probe in output: ${stdout}`);
    return JSON.parse(line.slice('WASM_PROVIDER:'.length)) as Probe;
}

Deno.test({ name: 'cli stage: wasm live-provider tags survive ESM and CJS module delivery', timeout: 30000 }, async () => {
    await withTempDir('wasm-live-provider-stage', async (root) => {
        await Deno.writeFile(join(root, 'exporter.wasm'), ADD_WASM);
        await Deno.writeFile(join(root, 'consumer-esm.wasm'), consumerWasm('./glue.js'));
        await Deno.writeFile(join(root, 'consumer-cjs.wasm'), consumerWasm('./glue.cjs'));
        await Deno.writeTextFile(join(root, 'glue.js'), 'export { add } from "./exporter.wasm";\n');
        await Deno.writeTextFile(join(root, 'glue.cjs'), 'module.exports = require("./exporter.wasm");\n');

        const probe = String.raw`
            const result = {
                value: run(20, 22),
                same: providerAdd === glueAdd,
                providerSymbols: Object.getOwnPropertySymbols(providerAdd).length,
                glueSymbols: Object.getOwnPropertySymbols(glueAdd).length,
                providerSource: Function.prototype.toString.call(providerAdd),
                glueSource: Function.prototype.toString.call(glueAdd),
            };
            console.log('WASM_PROVIDER:' + JSON.stringify(result));
        `;
        const esm = join(root, 'main.mjs');
        await Deno.writeTextFile(esm, `
            import { add as providerAdd } from './exporter.wasm';
            import { add as glueAdd } from './glue.js';
            import { run } from './consumer-esm.wasm';
            ${probe}
        `);
        const cjs = join(root, 'main.cjs');
        await Deno.writeTextFile(cjs, `
            const { add: providerAdd } = require('./exporter.wasm');
            const { add: glueAdd } = require('./glue.cjs');
            const { run } = require('./consumer-cjs.wasm');
            ${probe}
        `);

        const cacheDir = join(root, 'cache');
        const noOxcCacheDir = join(root, 'cache-no-oxc');
        const cases: Array<[string, string[]]> = [
            ['esm-cold', ['run', `--cache-dir=${cacheDir}`, '--no-lock', esm]],
            ['esm-hot', ['run', `--cache-dir=${cacheDir}`, '--no-lock', esm]],
            ['cjs-cold', ['run', `--cache-dir=${cacheDir}`, '--no-lock', cjs]],
            ['cjs-hot', ['run', `--cache-dir=${cacheDir}`, '--no-lock', cjs]],
            ['esm-no-cache', ['run', '--disable-cache', '--no-lock', esm]],
            ['cjs-no-cache', ['run', '--disable-cache', '--no-lock', cjs]],
            ['esm-no-oxc', ['run', `--cache-dir=${noOxcCacheDir}`, '--no-oxc', '--no-lock', esm]],
            ['cjs-no-oxc', ['run', `--cache-dir=${noOxcCacheDir}`, '--no-oxc', '--no-lock', cjs]],
        ];
        const badExitCodes: string[] = [];

        for (const [name, args] of cases) {
            const result = await runCno(args, root, { DEBUG: 'wasm' });
            const value = parseProbe(result.stdout);
            strictEqual(value.value, 42, name);
            strictEqual(value.same, true, `${name}: the glue export must retain object identity`);
            ok(value.providerSymbols >= 2, `${name}: native provider tags were lost: ${JSON.stringify(value)}`);
            strictEqual(value.glueSymbols, value.providerSymbols, name);
            deepStrictEqual(value.glueSource, value.providerSource, name);
            const output = result.stdout + result.stderr;
            ok(output.includes('resolved (live provider, sourceIndex=0)'),
                `${name}: native provider fast path was not selected:\n${output}`);
            ok(!output.includes('resolved (JavaScript trampoline)'),
                `${name}: import unexpectedly fell back to a JavaScript trampoline:\n${output}`);
            if (result.code !== 0) badExitCodes.push(`${name}=${result.code}`);
        }
        deepStrictEqual(badExitCodes, [], `staged cno runs aborted: ${badExitCodes.join(', ')}`);
    });
});
