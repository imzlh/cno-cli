// CNO_TEST_BINARY=/path/to/cno node --test tests/cts/esm-cycle-live-binding.test.mjs
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const repository = fileURLToPath(new URL('../../', import.meta.url));
const binary = resolve(repository, process.env.CNO_TEST_BINARY
    ?? `build/stage/cno${process.platform === 'win32' ? '.exe' : ''}`);

function cachedBytecode(cache) {
    const files = [];
    const visit = directory => {
        if (!existsSync(directory)) return;
        for (const entry of readdirSync(directory, { withFileTypes: true })) {
            const path = join(directory, entry.name);
            if (entry.isDirectory()) visit(path);
            else if (entry.name.endsWith('.jsc')) files.push(path);
        }
    };
    visit(cache);
    return files;
}

test('pure ESM cycles retain live bindings from source and warm bytecode', {
    skip: !existsSync(binary) && !process.env.CNO_TEST_BINARY ? 'Build cno or set CNO_TEST_BINARY first' : false,
    timeout: 90_000,
}, async t => {
    const directory = mkdtempSync(join(tmpdir(), 'cno-esm-cycle-live-'));
    t.after(() => {
        assert.equal(dirname(directory), resolve(tmpdir()));
        rmSync(directory, { recursive: true, force: true });
    });

    const fixture = join(directory, 'fixture');
    const runtimeCache = join(directory, 'runtime-cache');
    const cliCache = join(directory, 'cli-cache');
    mkdirSync(fixture);
    const a = join(fixture, 'a.mjs');
    const b = join(fixture, 'b.mjs');
    const entry = join(fixture, 'entry.mjs');
    writeFileSync(a, `
        import { b } from './b.mjs';
        export let a = 1;
        export const setA = value => { a = value; };
        export const readB = () => b;
    `);
    writeFileSync(b, `
        import { a } from './a.mjs';
        export let b = 2;
        export const setB = value => { b = value; };
        export const readA = () => a;
    `);
    writeFileSync(entry, `
        import { a, setA, readB } from './a.mjs';
        import { b, setB, readA } from './b.mjs';
        if (a !== 1 || b !== 2 || readA() !== 1 || readB() !== 2) {
            throw new Error('initial cycle bindings are incorrect');
        }
        setA(11);
        setB(22);
        if (a !== 11 || b !== 22 || readA() !== 11 || readB() !== 22) {
            throw new Error('cycle bindings are snapshots instead of live bindings');
        }
        console.log('PURE_ESM_CYCLE_LIVE_OK');
    `);

    const bundleDriver = async (outfile, warm) => {
        await build({
            absWorkingDir: repository, bundle: true, format: 'esm', platform: 'node',
            target: 'es2024', keepNames: true, outfile,
            stdin: {
                resolveDir: repository,
                contents: `
                    import { createRuntime } from './cts/src/api/index.ts';
                    const runtime = createRuntime({
                        cacheDir: ${JSON.stringify(runtimeCache)},
                        disableLock: true,
                        enableCache: true,
                        enableHttp: false,
                        enableJsr: false,
                        enableNode: false,
                        enableOxc: false,
                        silent: true,
                    }, ${JSON.stringify(fixture)});
                    if (${warm}) {
                        runtime.compiler.esm.compileEsm = () => {
                            throw new Error('warm run compiled source instead of loading bytecode');
                        };
                    }
                    try {
                        const module = await runtime.loadModule(${JSON.stringify(entry)}, {}, 'js');
                        await runtime.compiler.evalTracked(module);
                        console.log(${JSON.stringify(warm ? 'WARM_BYTECODE_OK' : 'COLD_SOURCE_OK')});
                    } finally {
                        runtime.cleanup();
                    }
                `,
            },
        });
    };
    const coldDriver = join(directory, 'cold-driver.mjs');
    const warmDriver = join(directory, 'warm-driver.mjs');
    await Promise.all([bundleDriver(coldDriver, false), bundleDriver(warmDriver, true)]);

    const run = args => {
        const result = spawnSync(binary, args, {
            cwd: repository, encoding: 'utf8', timeout: 30_000, windowsHide: true,
        });
        assert.ifError(result.error);
        assert.equal(result.status, 0, result.stdout + result.stderr);
        return result.stdout;
    };
    run(['setup', `--cache-dir=${cliCache}`]);
    assert.match(
        run(['run', `--cache-dir=${cliCache}`, '--no-lock', coldDriver]),
        /PURE_ESM_CYCLE_LIVE_OK[\s\S]*COLD_SOURCE_OK/,
    );
    assert.ok(cachedBytecode(runtimeCache).length >= 3, 'cold run must cache entry and both cycle modules');
    assert.match(
        run(['run', `--cache-dir=${cliCache}`, '--no-lock', warmDriver]),
        /PURE_ESM_CYCLE_LIVE_OK[\s\S]*WARM_BYTECODE_OK/,
    );
});
