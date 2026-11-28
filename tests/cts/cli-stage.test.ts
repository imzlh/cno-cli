import { deepStrictEqual, ok, strictEqual } from 'node:assert';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { decodeUtf8 } from '../_helpers/bytes.ts';
import { withTempDir } from '../_helpers/temp.ts';
import { runCno, runCnoWithInput, ADD_WASM } from '../_helpers/cli-stage-run.ts';

Deno.test({ name: 'cli stage: version and help commands exit successfully', timeout: 10000 }, async () => {
    const version = await runCno(['--version']);
    strictEqual(version.code, 0, version.stderr);
    ok(/^cno\s+\d+\.\d+\.\d+/.test(version.stdout.trim()));

    const help = await runCno(['--help']);
    strictEqual(help.code, 0, help.stderr);
    ok(help.stdout.includes('COMMANDS'));
    ok(help.stdout.includes('cno'));
});

Deno.test({ name: 'cli stage: eval runs inline code with Deno args empty', timeout: 10000 }, async () => {
    await withTempDir('cli-eval', async (root) => {
        const result = await runCno([
            'eval',
            'console.log("EVAL:" + JSON.stringify({ args: Deno.args, main: Deno.mainModule.endsWith("<eval>.ts") }))',
        ], root);
        strictEqual(result.code, 0, result.stdout + result.stderr);
        ok(result.stdout.includes('EVAL:{"args":[]'), result.stdout);
    });
});

Deno.test({ name: 'cli stage: eval supports print and extension modes', timeout: 15000 }, async () => {
    await withTempDir('cli-eval-ext', async (root) => {
        const print = await runCno(['eval', '-p', '1+2'], root);
        strictEqual(print.code, 0, print.stderr);
        strictEqual(print.stdout.trim(), '3');
        ok(!print.stderr.includes('unknown flag --p'), print.stderr);

        const asTs = await runCno(['eval', '--quiet', '--ext=ts', 'console.log((123)as(number))'], root);
        strictEqual(asTs.code, 0, asTs.stderr);
        strictEqual(asTs.stdout.trim(), '123');

        await Deno.writeTextFile(join(root, 'say_hello.js'), 'console.log("Hello!");\n');
        const cjs = await runCno(['eval', '--quiet', '--ext=cjs', "require('./say_hello')"], root);
        strictEqual(cjs.code, 0, cjs.stderr);
        strictEqual(cjs.stdout.trim(), 'Hello!');

        const cts = await runCno(['eval', '--quiet', '--ext=cts', "import test = require('./say_hello.js');"], root);
        strictEqual(cts.code, 0, cts.stderr);
        strictEqual(cts.stdout.trim(), 'Hello!');
    });
});

Deno.test({ name: 'cli stage: ESM require retains module context across async calls and bytecode', timeout: 30000 }, async () => {
    await withTempDir('cli-esm-require', async (root) => {
        for (const name of ['first', 'second']) {
            const dir = join(root, name);
            Deno.mkdirSync(dir);
            Deno.writeTextFileSync(join(dir, 'local.cjs'), `module.exports = ${JSON.stringify(name)};`);
            Deno.writeTextFileSync(join(dir, 'loader.ts'), `
                export const saved = require;
                export async function load() {
                    await Promise.resolve();
                    return [require('./local.cjs'), require.resolve('./local.cjs')];
                }
            `);
        }
        const entry = join(root, 'main.ts');
        Deno.writeTextFileSync(join(root, 'local.cjs'), 'module.exports = "entry";');
        Deno.writeTextFileSync(entry, `
            import { saved as first, load as loadFirst } from './first/loader.ts';
            import { saved as second, load as loadSecond } from './second/loader.ts';
            const loaded = await Promise.all([loadFirst(), loadSecond()]);
            console.log(JSON.stringify({
                saved: [first('./local.cjs'), second('./local.cjs')],
                loaded,
                entry: require('./local.cjs'),
                identity: first === (await import('./first/loader.ts')).saved,
            }));
        `);
        for (const flags of [[], [], ['--disable-cache']]) {
            const result = await runCno(['run', '--no-lock', ...flags, entry], root);
            strictEqual(result.code, 0, result.stderr);
            deepStrictEqual(JSON.parse(result.stdout), {
                saved: ['first', 'second'],
                loaded: [
                    ['first', join(root, 'first/local.cjs')],
                    ['second', join(root, 'second/local.cjs')],
                ],
                entry: 'entry',
                identity: true,
            });
        }
    });
});

Deno.test({ name: 'cli stage: run and implicit run pass script arguments after entry', timeout: 10000 }, async () => {
    await withTempDir('cli-run', async (root) => {
        const script = join(root, 'main.ts');
        await Deno.writeTextFile(script, `
            console.log("RUN:" + JSON.stringify({
                args: Deno.args,
            }));
        `);

        const explicit = await runCno(['run', '--no-lock', script, '--user-flag', 'value'], root);
        strictEqual(explicit.code, 0, explicit.stderr);
        ok(explicit.stdout.includes('"args":["--user-flag","value"]'), explicit.stdout);

        await Deno.writeTextFile(join(root, 'deno.json'), JSON.stringify({}));
        const withValueFlag = await runCno(['run', '--config', 'deno.json', script, 'after'], root);
        strictEqual(withValueFlag.code, 0, withValueFlag.stderr);
        ok(withValueFlag.stdout.includes('"args":["after"]'), withValueFlag.stdout);

        const dashValue = await runCno(['run', '--cache-dir', '-cache', script, 'dash'], root);
        strictEqual(dashValue.code, 0, dashValue.stderr);
        ok(!dashValue.stderr.includes('unknown flag --cache'), dashValue.stderr);
        ok(dashValue.stdout.includes('"args":["dash"]'), dashValue.stdout);

        const terminator = await runCno(['run', '--no-lock', '--', script, '--user-flag'], root);
        strictEqual(terminator.code, 0, terminator.stderr);
        ok(!terminator.stderr.includes('unknown flag --'), terminator.stderr);
        ok(terminator.stdout.includes('"args":["--user-flag"]'), terminator.stdout);

        const implicit = await runCno([script, 'positional'], root);
        strictEqual(implicit.code, 0, implicit.stderr);
        ok(implicit.stdout.includes('"args":["positional"]'), implicit.stdout);
    });
});

// A clean source-only cache can spend over 20 seconds in the first runtime
// startup and transform; the second run is warm. Keep the test below the
// outer worker deadline while allowing the measured cold path to complete.
Deno.test({ name: 'cli stage: run --cwd resolves files, config, preloads and argv from the execution directory', timeout: 45000 }, async () => {
    await withTempDir('cli-run-cwd', async (root) => {
        const cacheDir = join(root, 'cache');
        const setup = await runCno(['setup', `--cache-dir=${cacheDir}`], root);
        strictEqual(setup.code, 0, setup.stderr);

        const app = join(root, 'app');
        const source = join(app, 'src');
        await Deno.mkdir(source, { recursive: true });
        await Deno.writeTextFile(join(root, '.env'), 'CNO_RUN_CWD_ENV=invocation\n');
        await Deno.writeTextFile(join(app, '.env'), 'CNO_RUN_CWD_ENV=wrong-directory\n');
        await Deno.writeTextFile(join(app, 'data.txt'), 'execution-directory');
        await Deno.writeTextFile(join(app, 'preload.ts'), 'Deno.env.set("CNO_RUN_PRELOAD_CWD", Deno.cwd());');
        await Deno.writeTextFile(join(source, 'deno.json'), JSON.stringify({
            imports: { 'cwd-dependency': './dep.ts' },
        }));
        await Deno.writeTextFile(join(source, 'dep.ts'), 'export default "entry-config";');
        await Deno.writeTextFile(join(source, 'local.cjs'), 'module.exports = "relative-require";');
        const entry = join(source, 'main.ts');
        await Deno.writeTextFile(entry, `
            import process from 'node:process';
            import dependency from 'cwd-dependency';
            import { value } from './relative.ts';
            setTimeout(() => console.log(JSON.stringify({
                cwd: Deno.cwd(), nodeCwd: process.cwd(), argv: process.argv.slice(1),
                args: Deno.args, main: Deno.mainModule, dependency, value,
                required: require('./local.cjs'), data: Deno.readTextFileSync('data.txt'),
                env: Deno.env.get('CNO_RUN_CWD_ENV'), preload: Deno.env.get('CNO_RUN_PRELOAD_CWD'),
            })), 0);
        `);
        await Deno.writeTextFile(join(source, 'relative.ts'), 'export const value = "relative-import";');
        const expectedApp = Deno.realPathSync(app).replaceAll('\\', '/');
        const expectedEntry = Deno.realPathSync(entry).replaceAll('\\', '/');
        for (const [runDir, target] of [['app', 'src/main.ts'], [app, entry]]) {
            const result = await runCno([
                'run', '--no-lock', '--no-oxc', '--cache-dir', cacheDir,
                '--env-file=.env', '--preload=./preload.ts', '--cwd', runDir, target,
                '--cwd', 'script-argument',
            ], root);
            strictEqual(result.code, 0, result.stderr);
            const output = JSON.parse(result.stdout);
            strictEqual(output.cwd.replaceAll('\\', '/'), expectedApp);
            strictEqual(output.nodeCwd.replaceAll('\\', '/'), expectedApp);
            strictEqual(output.preload.replaceAll('\\', '/'), expectedApp);
            strictEqual(output.argv[0].replaceAll('\\', '/'), expectedEntry);
            deepStrictEqual(output.args, ['--cwd', 'script-argument']);
            deepStrictEqual(output.argv.slice(1), output.args);
            strictEqual(output.main, pathToFileURL(Deno.realPathSync(entry)).href);
            strictEqual(output.dependency, 'entry-config');
            strictEqual(output.value, 'relative-import');
            strictEqual(output.required, 'relative-require');
            strictEqual(output.data, 'execution-directory');
            strictEqual(output.env, 'invocation');
        }
    });
});

Deno.test({ name: 'cli stage: run --cwd detects extensionless files before task fallback and rejects invalid directories', timeout: 15000 }, async () => {
    await withTempDir('cli-run-cwd-routing', async (root) => {
        const cacheDir = join(root, 'cache');
        const setup = await runCno(['setup', `--cache-dir=${cacheDir}`], root);
        strictEqual(setup.code, 0, setup.stderr);

        const app = join(root, 'app');
        await Deno.mkdir(app);
        await Deno.writeTextFile(join(app, 'deno.json'), JSON.stringify({ tasks: { probe: 'echo WRONG_TASK' } }));
        await Deno.writeTextFile(join(root, 'probe'), 'throw new Error("WRONG_FILE");');
        await Deno.writeTextFile(join(app, 'probe'), 'console.log("CWD_FILE");');
        const file = await runCno(['run', '--no-lock', `--cache-dir=${cacheDir}`, '--cwd=app', 'probe'], root);
        strictEqual(file.code, 0, file.stderr);
        strictEqual(file.stdout.trim(), 'CWD_FILE');

        await Deno.writeTextFile(join(app, 'not-a-directory'), '');
        for (const dir of ['missing', join(app, 'not-a-directory')]) {
            const failed = await runCno(['run', '--no-lock', `--cache-dir=${cacheDir}`, '--cwd', dir, join(app, 'probe')], root);
            strictEqual(failed.code, 1, failed.stdout + failed.stderr);
            ok(!failed.stdout.includes('CWD_FILE'), failed.stdout);
            ok(failed.stderr.trim().length > 0, 'invalid cwd must report an error');
        }
    });
});

Deno.test({ name: 'cli stage: test passes arguments after the option terminator', timeout: 10000 }, async () => {
    await withTempDir('cli-test-args', async (root) => {
        const testFile = join(root, 'args_test.ts');
        await Deno.writeTextFile(testFile, `
            import { deepStrictEqual } from 'node:assert';
            Deno.test('receives script args', () => {
                console.log('TEST_ARGS:' + JSON.stringify(Deno.args));
                deepStrictEqual(Deno.args, ['fixture', '--filter=user-value']);
            });
        `);

        const result = await runCno([
            'test',
            testFile,
            '--filter=receives',
            '--',
            'fixture',
            '--filter=user-value',
        ], root);
        strictEqual(result.code, 0, result.stderr);
        ok(result.stdout.includes('TEST_ARGS:["fixture","--filter=user-value"]'), result.stdout);
    });
});

Deno.test({ name: 'cli stage: test reports module evaluation errors', timeout: 10000 }, async () => {
    await withTempDir('cli-test-module-error', async (root) => {
        const testFile = join(root, 'broken_test.ts');
        await Deno.writeTextFile(testFile, `throw new Error('MODULE_EVALUATION_FAILED');\n`);

        const result = await runCno(['test', testFile], root);
        strictEqual(result.code, 1, result.stdout + result.stderr);
        ok(result.stderr.includes('MODULE_EVALUATION_FAILED'), result.stdout + result.stderr);
    });
});

Deno.test({ name: 'cli stage: run supports local query hash imports and BOM sources', timeout: 10000 }, async () => {
    await withTempDir('cli-run-local-specs', async (root) => {
        await Deno.writeTextFile(join(root, 'hello.js'), 'console.log("HELLO-JS");\n');
        await Deno.writeTextFile(join(root, 'hello.ts'), 'console.log("HELLO-TS");\n');
        await Deno.writeTextFile(join(root, 'query.ts'), `
            import './hello.js?a=b#c';
            import './hello.ts?a=b#c';
        `);

        const query = await runCno(['run', join(root, 'query.ts')], root);
        strictEqual(query.code, 0, query.stderr);
        ok(query.stdout.includes('HELLO-JS'), query.stdout);
        ok(query.stdout.includes('HELLO-TS'), query.stdout);

        const bom = join(root, 'bom.ts');
        await Deno.writeFile(bom, new Uint8Array([0xef, 0xbb, 0xbf, ...new TextEncoder().encode(`
            import './hello.js';
        `)]));

        const bomRun = await runCno(['run', bom], root);
        strictEqual(bomRun.code, 0, bomRun.stderr);
        ok(bomRun.stdout.includes('HELLO-JS'), bomRun.stdout);
    });
});

Deno.test({ name: 'cli stage: run exposes import.meta entry metadata', timeout: 10000 }, async () => {
    await withTempDir('cli-run-import-meta', async (root) => {
        await Deno.writeTextFile(join(root, 'dep.ts'), 'export const value = 1;\n');
        const main = join(root, 'main.ts');
        const expectedRoot = Deno.realPathSync(root).replaceAll('\\', '/');
        await Deno.writeTextFile(main, `
            if (!import.meta.main) throw new Error("entry must be main");
            console.log("META:" + JSON.stringify({
                url: import.meta.url.startsWith("file://"),
                filename: import.meta.filename.replace(/\\\\/g, "/").endsWith("/main.ts"),
                dirname: import.meta.dirname.replace(/\\\\/g, "/").endsWith(${JSON.stringify(expectedRoot)}),
                resolve: import.meta.resolve("./dep.ts").endsWith("/dep.ts"),
            }));
        `);

        const result = await runCno(['run', main], root);
        strictEqual(result.code, 0, result.stderr);
        ok(result.stdout.includes('"url":true'), result.stdout);
        ok(result.stdout.includes('"filename":true'), result.stdout);
        ok(result.stdout.includes('"dirname":true'), result.stdout);
        ok(result.stdout.includes('"resolve":true'), result.stdout);
    });
});

Deno.test({ name: 'cli stage: run exposes Deno.mainModule to dependencies', timeout: 10000 }, async () => {
    await withTempDir('cli-run-main-module', async (root) => {
        await Deno.writeTextFile(join(root, 'other.ts'), `
            console.log("other", Deno.mainModule.endsWith("/main.ts"));
        `);
        const main = join(root, 'main.ts');
        await Deno.writeTextFile(main, `
            import "./other.ts";
            console.log("main", Deno.mainModule.endsWith("/main.ts"));
        `);

        const result = await runCno(['run', main], root);
        strictEqual(result.code, 0, result.stderr);
        deepStrictEqual(result.stdout.trim().split(/\r?\n/), ['other true', 'main true']);
    });
});

Deno.test({ name: 'cli stage: run defaults stdin and extensionless entries to TypeScript', timeout: 15000 }, async () => {
    await withTempDir('cli-run-default-ts', async (root) => {
        const stdin = await runCnoWithInput(['run', '-'], 'const x: string = "foo"; console.log(x);\n', root);
        strictEqual(stdin.code, 0, stdin.stderr);
        strictEqual(stdin.stdout.trim(), 'foo');

        const extensionless = join(root, 'extensionless');
        await Deno.writeTextFile(extensionless, 'const x: string = "foo"; console.log(x);\n');
        const extlessRun = await runCno(['run', extensionless], root);
        strictEqual(extlessRun.code, 0, extlessRun.stderr);
        strictEqual(extlessRun.stdout.trim(), 'foo');

        const asTsJs = join(root, 'as_ts.js');
        await Deno.writeTextFile(asTsJs, 'const x: string = "foo"; console.log(x);\n');
        const extFlag = await runCno(['run', '--ext=ts', asTsJs], root);
        strictEqual(extFlag.code, 0, extFlag.stderr);
        strictEqual(extFlag.stdout.trim(), 'foo');
        ok(!extFlag.stderr.includes('unknown flag --ext'), extFlag.stderr);
    });
});

Deno.test({ name: 'cli stage: run propagates Deno exit codes', timeout: 15000 }, async () => {
    await withTempDir('cli-run-exit-code', async (root) => {
        const exitCodeFile = join(root, 'exit_code.js');
        await Deno.writeTextFile(exitCodeFile, `
            if (Deno.exitCode !== 0) throw new Error("bad default");
            Deno.exitCode = 42;
            console.log("Deno.exitCode", Deno.exitCode);
        `);
        const exitCode = await runCno(['run', exitCodeFile], root);
        strictEqual(exitCode.code, 42);
        ok(exitCode.stdout.includes('Deno.exitCode 42'), exitCode.stdout);

        const exitFile = join(root, 'exit.ts');
        await Deno.writeTextFile(exitFile, `
            console.log("before");
            Deno.exit(42);
            console.log("after");
        `);
        const exited = await runCno(['run', exitFile], root);
        strictEqual(exited.code, 42);
        ok(exited.stdout.includes('before'), exited.stdout);
        ok(!exited.stdout.includes('after'), exited.stdout);
    });
});

Deno.test({ name: 'cli stage: run dedupes concurrent dynamic imports already evaluating', timeout: 10000 }, async () => {
    await withTempDir('cli-run-dynamic-import', async (root) => {
        const target = join(root, 'target.ts');
        const entry = join(root, 'main.ts');
        await Deno.writeTextFile(target, `
            console.log('TARGET-START');
            await new Promise((resolve) => setTimeout(resolve, 25));
            console.log('TARGET-END');
        `);
        await Deno.writeTextFile(entry, `
            import('./target.ts').then(() => console.log('DONE'));
            import('./target.ts').then(() => console.log('DONE'));
        `);

        const result = await runCno(['run', entry], root);
        strictEqual(result.code, 0, result.stderr);
        const lines = result.stdout.trim().split(/\r?\n/).filter(Boolean);
        strictEqual(lines.filter((line) => line === 'TARGET-START').length, 1, result.stdout);
        strictEqual(lines.filter((line) => line === 'TARGET-END').length, 1, result.stdout);
        strictEqual(lines.filter((line) => line === 'DONE').length, 2, result.stdout);
        ok(lines.indexOf('TARGET-START') < lines.indexOf('TARGET-END'), result.stdout);
    });
});

Deno.test({ name: 'cli stage: run supports mts type imports and CJS entry semantics', timeout: 15000 }, async () => {
    await withTempDir('cli-run-module-kinds', async (root) => {
        await Deno.writeTextFile(join(root, 'mod.mjs'), 'export const a = "a";\n');
        await Deno.writeTextFile(join(root, 'types.d.mts'), 'export type A = "a";\n');
        const mtsEntry = join(root, 'import.mts');
        await Deno.writeTextFile(mtsEntry, `
            import * as a from "./mod.mjs";
            import { type A } from "./types.d.mts";
            console.log(a.a as A);
        `);
        const mts = await runCno(['run', mtsEntry], root);
        strictEqual(mts.code, 0, mts.stderr);
        strictEqual(mts.stdout.trim(), 'a');

        const cjsEntry = join(root, 'main.cjs');
        await Deno.writeTextFile(cjsEntry, `
            console.log(require.main === module, require.main.id, require.main.filename.endsWith("main.cjs"));
        `);
        const cjs = await runCno(['run', cjsEntry], root);
        strictEqual(cjs.code, 0, cjs.stderr);
        strictEqual(cjs.stdout.trim(), 'true . true');

        await Deno.writeTextFile(join(root, 'output.cjs'), 'console.log("Hello"); module.exports = 1;\n');
        const dynamicCjsEntry = join(root, 'dynamic-cjs.ts');
        await Deno.writeTextFile(dynamicCjsEntry, `
            const moduleName = "./output.cjs";
            function getModuleName() {
                return moduleName;
            }
            await import(getModuleName());
        `);
        const dynamicCjs = await runCno(['run', dynamicCjsEntry], root);
        strictEqual(dynamicCjs.code, 0, dynamicCjs.stderr);
        strictEqual(dynamicCjs.stdout.trim(), 'Hello');
    });
});

Deno.test({ name: 'cli stage: run covers cts and js-to-ts module interop', timeout: 20000 }, async () => {
    await withTempDir('cli-run-cts-js-interop', async (root) => {
        const ctsMain = join(root, 'main.cts');
        await Deno.writeTextFile(join(root, 'import_main.cjs'), 'require("./main.cts").sayHello();\n');
        await Deno.writeTextFile(ctsMain, `
            module.exports.sayHello = function () {
                console.log("Hello");
            };
            require("./import_main.cjs");
        `);
        const ctsRun = await runCno(['run', ctsMain], root);
        strictEqual(ctsRun.code, 0, ctsRun.stderr);
        strictEqual(ctsRun.stdout.trim(), 'Hello');

        await Deno.writeTextFile(join(root, 'add.cts'), `
            export = function (a: number, b: number) {
                return a + b;
            };
        `);
        await Deno.writeTextFile(join(root, 'uses_add.cts'), `
            import add = require("./add.cts");
            console.log(add(1, 2));
        `);
        const addRun = await runCno(['run', join(root, 'uses_add.cts')], root);
        strictEqual(addRun.code, 0, addRun.stderr);
        strictEqual(addRun.stdout.trim(), '3');

        await Deno.writeTextFile(join(root, 'deno.json'), JSON.stringify({}));
        await Deno.writeTextFile(join(root, 'reexport.js'), 'export const isMod4 = true;\n');
        await Deno.writeTextFile(join(root, 'via_js.ts'), `
            import { isMod4 } from "./reexport.js";
            console.log(isMod4);
        `);
        await Deno.writeTextFile(join(root, 'print_hello.ts'), `
            export function printHello() {
                console.log("Hello");
            }
        `);
        await Deno.writeTextFile(join(root, 'deps.js'), `
            import "./print_hello.ts";
            export { printHello } from "./print_hello.ts";
        `);
        await Deno.writeTextFile(join(root, 'js_entry.js'), `
            import { printHello } from "./deps.js";
            printHello();
            console.log("success");
        `);
        // Both scenarios are plain ESM side-effect printers with disjoint
        // import chains, so one boot runs them back to back in evaluation order.
        const esmRunner = join(root, 'esm_interop.ts');
        await Deno.writeTextFile(esmRunner, `
            import "./via_js.ts";
            import "./js_entry.js";
        `);
        const esmRun = await runCno(['run', esmRunner], root);
        strictEqual(esmRun.code, 0, esmRun.stderr);
        const esmLines = esmRun.stdout.trim().split(/\r?\n/);
        strictEqual(esmLines[0], 'true', esmRun.stdout);
        // A .js file as the run entry still dispatches ESM (entry-format pin).
        const jsEntry = await runCno(['run', join(root, 'js_entry.js')], root);
        strictEqual(jsEntry.code, 0, jsEntry.stderr);
        deepStrictEqual(esmLines.slice(1), ['Hello', 'success'], esmRun.stdout);
        deepStrictEqual(jsEntry.stdout.trim().split(/\r?\n/), ['Hello', 'success'], jsEntry.stdout);

        const extensionlessJs = join(root, 'extensionless_js');
        await Deno.writeTextFile(extensionlessJs, `
            let i = 123;
            i = "hello";
            console.log("executing javascript with no extension");
        `);
        const extRun = await runCno(['run', '--ext=js', extensionlessJs], root);
        strictEqual(extRun.code, 0, extRun.stderr);
        strictEqual(extRun.stdout.trim(), 'executing javascript with no extension');
    });
});

Deno.test({ name: 'cli stage: run loads env files before entry', timeout: 15000 }, async () => {
    await withTempDir('cli-run-env-file', async (root) => {
        await Deno.writeTextFile(join(root, 'env'), [
            'FOO=BAR',
            'ANOTHER_FOO=ANOTHER_${FOO}',
            'MULTILINE="First Line',
            'Second Line"',
            'ESCAPED_NEWLINE="First Line\\nSecond Line"',
            'ESCAPED_QUOTE="First \\"Quoted\\" Line"',
            '',
        ].join('\n'));
        await Deno.writeTextFile(join(root, 'env_one'), 'ANOTHER_FOO=OVERRIDEN_BY_ENV_ONE\n');
        await Deno.writeTextFile(join(root, 'env_two'), 'FOO=OVERRIDEN_BY_ENV_TWO\n');
        await Deno.writeTextFile(join(root, 'bad_env'), 'FOO=valid\nANOTHER_FOO=c:\\path\n');

        const main = join(root, 'env_file.ts');
        await Deno.writeTextFile(main, `
            console.log(Deno.env.get("FOO"));
            console.log(Deno.env.get("ANOTHER_FOO"));
            console.log(Deno.env.get("MULTILINE"));
            console.log(Deno.env.get("ESCAPED_NEWLINE"));
            console.log(Deno.env.get("ESCAPED_QUOTE"));
        `);

        const basic = await runCno(['run', '--env=./env', main], root);
        strictEqual(basic.code, 0, basic.stderr);
        deepStrictEqual(basic.stdout.trim().split(/\r?\n/), [
            'BAR',
            'ANOTHER_BAR',
            'First Line',
            'Second Line',
            'First Line',
            'Second Line',
            'First "Quoted" Line',
        ]);

        const multiple = await runCno(['run', '--env=./env', '--env=./env_one', '--env-file=./env_two', main], root);
        strictEqual(multiple.code, 0, multiple.stderr);
        deepStrictEqual(multiple.stdout.trim().split(/\r?\n/), [
            'OVERRIDEN_BY_ENV_TWO',
            'OVERRIDEN_BY_ENV_ONE',
            'First Line',
            'Second Line',
            'First Line',
            'Second Line',
            'First "Quoted" Line',
        ]);

        const missing = await runCno(['run', '--env=./missing_env', main], root);
        strictEqual(missing.code, 0, missing.stderr);
        ok(missing.stderr.includes('Warning Failed to load env file'), missing.stderr);
        deepStrictEqual(missing.stdout.trim().split(/\r?\n/), ['undefined', 'undefined', 'undefined', 'undefined', 'undefined']);

        const bad = await runCno(['run', '--env=./bad_env', main], root);
        strictEqual(bad.code, 0, bad.stderr);
        ok(bad.stderr.includes('Warning Failed to parse env file'), bad.stderr);
        deepStrictEqual(bad.stdout.trim().split(/\r?\n/), ['undefined', 'undefined', 'undefined', 'undefined', 'undefined']);
    });
});

Deno.test({ name: 'cli stage: run supports process loadEnvFile', timeout: 15000 }, async () => {
    await withTempDir('cli-run-process-env-load', async (root) => {
        await Deno.writeTextFile(join(root, 'env'), 'FOO=BAR\n');
        const main = join(root, 'env_file.ts');
        await Deno.writeTextFile(main, `
            import { loadEnvFile } from "node:process";
            process.loadEnvFile("./env");
            Deno.env.delete("FOO");
            loadEnvFile(new URL("./env", import.meta.url));
            console.log(Deno.env.get("FOO"));
        `);

        const result = await runCno(['run', main], root);
        strictEqual(result.code, 0, result.stderr);
        strictEqual(result.stdout.trim(), 'BAR');
    });
});

Deno.test({ name: 'cli stage: run preloads modules before imports and dedupes entry preload', timeout: 15000 }, async () => {
    await withTempDir('cli-run-preload', async (root) => {
        await Deno.writeTextFile(join(root, 'preload.ts'), `
            console.log("preload starting");
            await new Promise((resolve) => setTimeout(resolve, 10));
            globalThis.__preload__ = true;
            console.log("preload finished");
        `);
        await Deno.writeTextFile(join(root, 'import.ts'), `
            console.log("import starting");
            await new Promise((resolve) => setTimeout(resolve, 10));
            globalThis.__import__ = true;
            console.log("import finished");
        `);
        const main = join(root, 'main.ts');
        await Deno.writeTextFile(main, `
            console.log("main started", globalThis.__preload__, globalThis.__import__);
        `);

        const ordered = await runCno(['--import', './import.ts', 'run', '--preload', './preload.ts', main], root);
        strictEqual(ordered.code, 0, ordered.stderr);
        deepStrictEqual(ordered.stdout.trim().split(/\r?\n/), [
            'preload starting',
            'preload finished',
            'import starting',
            'import finished',
            'main started true true',
        ]);

        const same = join(root, 'same.ts');
        await Deno.writeTextFile(same, 'console.log("executed");\n');
        const deduped = await runCno(['run', '--preload', same, same], root);
        strictEqual(deduped.code, 0, deduped.stderr);
        deepStrictEqual(deduped.stdout.trim().split(/\r?\n/), ['executed']);
    });
});

Deno.test({ name: 'cli stage: run honors NODE_OPTIONS require before cli require', timeout: 15000 }, async () => {
    await withTempDir('cli-run-node-options', async (root) => {
        await Deno.writeTextFile(join(root, 'require1.cjs'), 'console.log("require1.cjs");\n');
        await Deno.writeTextFile(join(root, 'require2.cjs'), 'console.log("require2.cjs");\n');
        await Deno.writeTextFile(join(root, 'require3.cjs'), 'console.log("require3.cjs");\n');
        const main = join(root, 'main.ts');
        await Deno.writeTextFile(main, 'console.log("main.ts");\n');

        const result = await runCno(['--require', './require3.cjs', 'run', main], root, {
            NODE_OPTIONS: '--require ./require1.cjs -r ./require2.cjs',
        });
        strictEqual(result.code, 0, result.stderr);
        deepStrictEqual(result.stdout.trim().split(/\r?\n/), [
            'require1.cjs',
            'require2.cjs',
            'require3.cjs',
            'main.ts',
        ]);

        // node's NODE_OPTIONS tokenizer treats `\` as literal OUTSIDE double
        // quotes (verified against node v24), so an unquoted absolute Windows
        // path must survive. Escaping everywhere turned C:\a\b.cjs into C:ab.cjs.
        const nativePath = join(root, 'require1.cjs');
        const nativeAbs = await runCno(['run', main], root, {
            NODE_OPTIONS: `--require ${nativePath}`,
        });
        strictEqual(nativeAbs.code, 0, nativeAbs.stderr);
        deepStrictEqual(nativeAbs.stdout.trim().split(/\r?\n/), ['require1.cjs', 'main.ts']);
    });
});

Deno.test({ name: 'cli stage: rejects malformed quoted NODE_OPTIONS', timeout: 15000 }, async () => {
    await withTempDir('cli-node-options-invalid', async (root) => {
        const main = join(root, 'main.ts');
        await Deno.writeTextFile(main, 'console.log("must not run");\n');

        const unterminated = await runCno(['run', main], root, { NODE_OPTIONS: '--require "broken' });
        strictEqual(unterminated.code, 1);
        ok(unterminated.stderr.includes('invalid value for NODE_OPTIONS (unterminated string)'), unterminated.stderr);
        strictEqual(unterminated.stdout, '');

        const invalidEscape = await runCno(['run', main], root, { NODE_OPTIONS: '--require "broken\\' });
        strictEqual(invalidEscape.code, 1);
        ok(invalidEscape.stderr.includes('invalid value for NODE_OPTIONS (invalid escape)'), invalidEscape.stderr);
        strictEqual(invalidEscape.stdout, '');

        const beforeInspector = await runCno(['--inspect=127.0.0.1:0', 'run', main], root, {
            NODE_OPTIONS: '--require "broken',
        });
        strictEqual(beforeInspector.code, 1);
        ok(beforeInspector.stderr.includes('invalid value for NODE_OPTIONS (unterminated string)'), beforeInspector.stderr);
        ok(!beforeInspector.stdout.includes('Debugger listening'), beforeInspector.stdout);
    });
});

Deno.test({ name: 'cli stage: run supports multiple require preloads with CJS metadata', timeout: 15000 }, async () => {
    await withTempDir('cli-run-require-multiple', async (root) => {
        await Deno.writeTextFile(join(root, 'require_first.js'), `
            console.log("require_first.js loading");
            const os = require("node:os");
            console.log("require_first.js platform:", os.platform());
            globalThis.__first__ = "first";
            globalThis.__first_filename__ = __filename;
            globalThis.__first_dirname__ = __dirname;
        `);
        await Deno.writeTextFile(join(root, 'require_second.js'), `
            console.log("require_second.js loading");
            const path = require("node:path");
            console.log("require_second.js path separator:", path.sep);
            globalThis.__second__ = "second";
            globalThis.__second_filename__ = __filename;
            globalThis.__second_dirname__ = __dirname;
        `);
        const main = join(root, 'main_multiple.ts');
        await Deno.writeTextFile(main, `
            console.log("main_multiple.ts starts");
            console.log(JSON.stringify({
                first: globalThis.__first__,
                second: globalThis.__second__,
                firstFilename: globalThis.__first_filename__.replace(/\\\\/g, "/").endsWith("/require_first.js"),
                secondFilename: globalThis.__second_filename__.replace(/\\\\/g, "/").endsWith("/require_second.js"),
                firstDirname: globalThis.__first_dirname__ === Deno.cwd(),
                secondDirname: globalThis.__second_dirname__ === Deno.cwd(),
            }));
            console.log("main_multiple.ts finished");
        `);

        const result = await runCno(['--require', './require_first.js', '--require', './require_second.js', 'run', main], root);
        strictEqual(result.code, 0, result.stderr);
        const lines = result.stdout.trim().split(/\r?\n/);
        strictEqual(lines[0], 'require_first.js loading', result.stdout);
        ok(lines[1].startsWith('require_first.js platform:'), result.stdout);
        strictEqual(lines[2], 'require_second.js loading', result.stdout);
        ok(lines[3].startsWith('require_second.js path separator:'), result.stdout);
        strictEqual(lines[4], 'main_multiple.ts starts', result.stdout);
        deepStrictEqual(JSON.parse(lines[5]), {
            first: 'first',
            second: 'second',
            firstFilename: true,
            secondFilename: true,
            firstDirname: true,
            secondDirname: true,
        });
        strictEqual(lines[6], 'main_multiple.ts finished', result.stdout);
    });
});

Deno.test({ name: 'cli stage: run requires sync ESM from CJS and rejects TLA ESM', timeout: 15000 }, async () => {
    await withTempDir('cli-run-require-esm', async (root) => {
        await Deno.writeTextFile(join(root, 'package.json'), JSON.stringify({ type: 'module' }));
        await Deno.writeTextFile(join(root, 'sync.js'), 'export const sync_js = 1;\n');
        await Deno.writeTextFile(join(root, 'sync.mjs'), 'export const sync_mjs = 1;\n');
        await Deno.writeTextFile(join(root, 'async.js'), 'export const async_js = 1;\nawait {};\n');
        const main = join(root, 'main.cjs');
        await Deno.writeTextFile(main, `
            console.log(JSON.stringify(require("./sync.js")));
            console.log(JSON.stringify(require("./sync.mjs")));
            try {
                require("./async.js");
            } catch (error) {
                console.log(error instanceof Error);
                console.log(
                    error.message.includes("Top-level await") ||
                    error.message.includes("synchronous") ||
                    error.message.includes("async ESM") ||
                    error.message.includes("dynamic import"),
                );
            }
        `);

        const result = await runCno(['run', main], root);
        strictEqual(result.code, 0, result.stderr);
        deepStrictEqual(result.stdout.trim().split(/\r?\n/), [
            '{"sync_js":1}',
            '{"sync_mjs":1}',
            'true',
            'true',
        ]);
    });
});

Deno.test({ name: 'cli stage: runtime SyntaxError in implicit CJS is not retried as ESM', timeout: 15000 }, async () => {
    await withTempDir('cli-run-cjs-runtime-syntax', async (root) => {
        await Deno.writeTextFile(join(root, 'child.js'), `
            globalThis.__cnoRuntimeSyntaxRuns = (globalThis.__cnoRuntimeSyntaxRuns || 0) + 1;
            globalThis.__cnoRuntimeSyntaxCjs = module.exports === exports && this === exports;
            throw new SyntaxError('user runtime error');
        `);
        const main = join(root, 'main.cjs');
        await Deno.writeTextFile(main, `
            try {
                require('./child.js');
            } catch (error) {
                console.log(error instanceof SyntaxError, error.message,
                    globalThis.__cnoRuntimeSyntaxRuns, globalThis.__cnoRuntimeSyntaxCjs);
            }
        `);

        const result = await runCno(['run', main], root);
        strictEqual(result.code, 0, result.stdout + result.stderr);
        strictEqual(result.stdout.trim(), 'true user runtime error 1 true');
    });
});

Deno.test({ name: 'cli stage: run preserves dynamic import TLA and failure caching', timeout: 20000 }, async () => {
    await withTempDir('cli-run-dynamic-cache', async (root) => {
        await Deno.writeTextFile(join(root, 'pending.ts'), `
            await new Promise((resolve) => setTimeout(resolve, 25));
            export default {};
        `);
        const pendingMain = join(root, 'pending_main.ts');
        await Deno.writeTextFile(pendingMain, `
            const imports = await Promise.all([
                import("./pending.ts"),
                import("./pending.ts"),
                import("./pending.ts"),
                import("./pending.ts"),
                import("./pending.ts"),
            ]);
            console.log(imports.every((item) => item === imports[0]), imports[0].default !== undefined);
        `);
        const pending = await runCno(['run', pendingMain], root);
        strictEqual(pending.code, 0, pending.stderr);
        strictEqual(pending.stdout.trim(), 'true true');

        const missingMain = join(root, 'missing_main.ts');
        await Deno.writeTextFile(missingMain, `
            try {
                await import("./later.ts");
            } catch {
                console.log("first fail");
            }
            await Deno.writeTextFile("./later.ts", "console.log('created later');\\n");
            try {
                await import("./later.ts");
            } catch {
                console.log("second fail");
            }
        `);
        const missing = await runCno(['run', missingMain], root);
        strictEqual(missing.code, 0, missing.stderr);
        deepStrictEqual(missing.stdout.trim().split(/\r?\n/), ['first fail', 'second fail']);

        await Deno.writeTextFile(join(root, 'throws.ts'), 'throw new Error("thrown once");\n');
        const rejectedMain = join(root, 'rejected_main.ts');
        await Deno.writeTextFile(rejectedMain, `
            for (let i = 0; i < 2; i++) {
                try {
                    await import("./throws.ts");
                } catch (error) {
                    console.log(error instanceof Error, error.message);
                }
            }
        `);
        const rejected = await runCno(['run', rejectedMain], root);
        strictEqual(rejected.code, 0, rejected.stderr);
        deepStrictEqual(rejected.stdout.trim().split(/\r?\n/), [
            'true thrown once',
            'true thrown once',
        ]);
    });
});

Deno.test({ name: 'cli stage: run covers private fields and weak references', timeout: 15000 }, async () => {
    await withTempDir('cli-run-es-runtime', async (root) => {
        // Plain language-feature observations with no flags, entry semantics or
        // module-registry interplay, so all three subjects share one boot and
        // print one marker line each.
        const esRuntime = join(root, 'es_runtime.ts');
        await Deno.writeTextFile(esRuntime, `
            class Person {
                #name: string;
                constructor(name: string) {
                    this.#name = name;
                }
                equals(other: unknown) {
                    return other &&
                        typeof other === "object" &&
                        #name in other &&
                        this.#name === other.#name;
                }
            }
            const a = new Person("alice");
            console.log(a.equals(new Person("bob")));
            console.log(a.equals(new Person("alice")));

            class Foo {
                #field = "field";
                setValue(val) {
                    this.#field = val;
                }
                getValue() {
                    return this.#field;
                }
            }
            const bar = new Foo();
            bar.setValue("PRIVATE");
            console.log(bar.getValue());

            console.log(typeof WeakRef, typeof FinalizationRegistry);
        `);
        const result = await runCno(['run', esRuntime], root);
        strictEqual(result.code, 0, result.stderr);
        deepStrictEqual(result.stdout.trim().split(/\r?\n/), ['false', 'true', 'PRIVATE', 'function function']);
    });
});

Deno.test({ name: 'cli stage: run imports wasm modules from ESM CJS and CTS', timeout: 20000 }, async () => {
    await withTempDir('cli-run-wasm-module', async (root) => {
        await Deno.writeFile(join(root, 'add.wasm'), ADD_WASM);

        const esm = join(root, 'main.mjs');
        await Deno.writeTextFile(esm, `
            import wasm, { add } from "./add.wasm";
            console.log(add(1, 2));
            console.log(wasm.add(9, 3));
        `);
        const esmRun = await runCno(['run', esm], root);
        strictEqual(esmRun.code, 0, esmRun.stderr);
        deepStrictEqual(esmRun.stdout.trim().split(/\r?\n/).filter((line) => /^\d+$/.test(line)), ['3', '12']);

        const cjs = join(root, 'main.cjs');
        await Deno.writeTextFile(cjs, `
            const { add } = require("./add.wasm");
            console.log(add(4, 5));
        `);
        const cjsRun = await runCno(['run', cjs], root);
        strictEqual(cjsRun.code, 0, cjsRun.stderr);
        deepStrictEqual(cjsRun.stdout.trim().split(/\r?\n/).filter((line) => /^\d+$/.test(line)), ['9']);

        const cts = join(root, 'main.cts');
        await Deno.writeTextFile(cts, `
            import WasmModule = require("./add.wasm");
            console.log(WasmModule.add(6, 7));
        `);
        const ctsRun = await runCno(['run', cts], root);
        strictEqual(ctsRun.code, 0, ctsRun.stderr);
        deepStrictEqual(ctsRun.stdout.trim().split(/\r?\n/).filter((line) => /^\d+$/.test(line)), ['13']);
    });
});

Deno.test({ name: 'cli stage: run imports CJS files from ESM package entry points', timeout: 15000 }, async () => {
    await withTempDir('cli-run-import-common-js', async (root) => {
        await Deno.mkdir(join(root, 'node_modules', 'foo'), { recursive: true });
        await Deno.writeTextFile(join(root, 'node_modules', 'foo', 'package.json'), JSON.stringify({ main: './index.mjs' }));
        await Deno.writeTextFile(join(root, 'node_modules', 'foo', 'index.mjs'), `
            import process from "node:process";
            import path from "node:path";
            import url from "node:url";
            export default async function () {
                console.log("hello from foo node module");
                const cjsFileToImport = path.join(process.cwd(), "index.cjs");
                const cjsModule = await import(url.pathToFileURL(cjsFileToImport));
                console.log("cjsModule.cwd()", cjsModule.cwd() === process.cwd());
            }
        `);
        await Deno.writeTextFile(join(root, 'index.cjs'), `
            const process = require("process");
            console.log(process.cwd() === ${JSON.stringify(root)});
            module.exports = { cwd: process.cwd };
        `);
        const main = join(root, 'main.ts');
        await Deno.writeTextFile(main, `
            import foo from "foo";
            await foo();
        `);

        const result = await runCno(['run', main], root);
        strictEqual(result.code, 0, result.stderr);
        deepStrictEqual(result.stdout.trim().split(/\r?\n/), [
            'hello from foo node module',
            'true',
            'cjsModule.cwd() true',
        ]);
    });
});

Deno.test({ name: 'cli stage: run lets package CJS require local JS ESM sources', timeout: 15000 }, async () => {
    await withTempDir('cli-run-npm-pkg-requires-esm-js', async (root) => {
        await Deno.writeTextFile(join(root, 'package.json'), JSON.stringify({ type: 'module' }));
        await Deno.mkdir(join(root, 'node_modules', 'package'), { recursive: true });
        await Deno.writeTextFile(join(root, 'node_modules', 'package', 'package.json'), JSON.stringify({
            name: 'package',
            version: '1.0.0',
        }));
        await Deno.writeTextFile(join(root, 'node_modules', 'package', 'index.js'), `
            module.exports = (file) => require(file);
        `);
        await Deno.writeTextFile(join(root, 'file.js'), `
            console.log(import.meta.url.startsWith("file://"));
            export const value = 1;
        `);
        const main = join(root, 'main.js');
        await Deno.writeTextFile(main, `
            import doRequire from "package";
            import path from "node:path";
            console.log(doRequire(path.resolve(import.meta.dirname, "file.js")).value);
        `);

        const result = await runCno(['run', main], root);
        strictEqual(result.code, 0, result.stderr);
        deepStrictEqual(result.stdout.trim().split(/\r?\n/), ['true', '1']);
    });
});

Deno.test({ name: 'cli stage: run handles duplicate dynamic imports and async catch flow', timeout: 20000 }, async () => {
    await withTempDir('cli-run-dynamic-flow', async (root) => {
        await Deno.mkdir(join(root, 'subdir2'));
        await Deno.writeTextFile(join(root, 'print_hello.ts'), `
            export function printHello() {
                console.log("Hello");
            }
        `);
        await Deno.writeTextFile(join(root, 'subdir2', 'mod2.ts'), `
            import { printHello } from "../print_hello.ts";
            export function printHello2() {
                printHello();
            }
        `);
        await Deno.writeTextFile(join(root, 'mod1.ts'), `
            import { printHello2 } from "./subdir2/mod2.ts";
            console.log("mod1 instantiated");
            export function printHello3() {
                printHello2();
            }
        `);
        const parallel = join(root, 'parallel.js');
        await Deno.writeTextFile(parallel, `
            Promise.all(new Array(100).fill(null).map(() => import("./mod1.ts"))).then((imports) => {
                if (!imports.every((item) => item === imports[0])) {
                    throw new Error("More than one instance of the same module.");
                }
                imports[0].printHello3();
            });
        `);
        const parallelRun = await runCno(['run', parallel], root);
        strictEqual(parallelRun.code, 0, parallelRun.stderr);
        deepStrictEqual(parallelRun.stdout.trim().split(/\r?\n/), ['mod1 instantiated', 'Hello']);

        // double-await and async-catch are deterministic side-effect printers
        // with no entry semantics, so they share one boot. Sequential dynamic
        // imports pin the order: awaiting each import settles its top-level
        // await before the next module evaluates (a static import would let
        // async_catch's synchronous body print while double_await's TLA is
        // still pending). The concurrent-import case above keeps its own
        // boot: its subject is per-process dynamic-import deduplication.
        const doubleAwait = join(root, 'double_await.ts');
        await Deno.writeTextFile(doubleAwait, `
            const currDirInfo = await Deno.stat(".");
            const parentDirInfo = await Deno.stat("..");
            console.log(currDirInfo.isDirectory);
            console.log(parentDirInfo.isFile);
        `);
        const asyncCatch = join(root, 'async_catch.ts');
        await Deno.writeTextFile(asyncCatch, `
            function fn(): Promise<never> {
                throw new Error("message");
            }
            async function call() {
                try {
                    console.log("before await fn()");
                    await fn();
                    console.log("after await fn()");
                } catch {
                    console.log("catch");
                }
                console.log("after try-catch");
            }
            call().catch(() => console.log("outer catch"));
        `);
        const flowRunner = join(root, 'flow_runner.ts');
        await Deno.writeTextFile(flowRunner, `
            await import("./double_await.ts");
            await import("./async_catch.ts");
        `);
        const flow = await runCno(['run', flowRunner], root);
        strictEqual(flow.code, 0, flow.stderr);
        const flowLines = flow.stdout.trim().split(/\r?\n/);
        deepStrictEqual(flowLines.slice(0, 2), ['true', 'false'], flow.stdout);
        deepStrictEqual(flowLines.slice(2), [
            'before await fn()',
            'catch',
            'after try-catch',
        ], flow.stdout);
    });
});

Deno.test({ name: 'cli stage: run keeps Deno args and runtime-written dynamic imports fresh', timeout: 20000 }, async () => {
    await withTempDir('cli-run-dynamic-written', async (root) => {
        const argsMain = join(root, 'args.ts');
        await Deno.writeTextFile(argsMain, `
            for (const arg of Deno.args) console.log(arg);
        `);
        const args = await runCno(['run', argsMain, '--arg1', 'val1', '--arg2=val2', '--', 'arg3', 'arg4'], root);
        strictEqual(args.code, 0, args.stderr);
        deepStrictEqual(args.stdout.trim().split(/\r?\n/), ['--arg1', 'val1', '--arg2=val2', '--', 'arg3', 'arg4']);

        const directMain = join(root, 'direct.ts');
        await Deno.writeTextFile(directMain, `
            Deno.writeTextFileSync("./a.ts", "console.log(1);");
            await import("./a.ts");
            Deno.writeTextFileSync("./a.ts", "console.log(2);");
        `);
        const firstDirect = await runCno(['run', directMain], root);
        strictEqual(firstDirect.code, 0, firstDirect.stderr);
        strictEqual(firstDirect.stdout.trim(), '1');
        const secondDirect = await runCno(['run', directMain], root);
        strictEqual(secondDirect.code, 0, secondDirect.stderr);
        strictEqual(secondDirect.stdout.trim(), '1');

        await Deno.writeTextFile(join(root, 'dep.ts'), 'import "./b.ts";\n');
        const depMain = join(root, 'dep_main.ts');
        await Deno.writeTextFile(depMain, `
            Deno.writeTextFileSync("./b.ts", "console.log(1);");
            const specifier = "./dep.ts" + "";
            await import(specifier);
            await import("./b.ts");
            Deno.writeTextFileSync("./b.ts", "console.log(2);");
        `);
        const firstDep = await runCno(['run', depMain], root);
        strictEqual(firstDep.code, 0, firstDep.stderr);
        strictEqual(firstDep.stdout.trim(), '1');
        const secondDep = await runCno(['run', depMain], root);
        strictEqual(secondDep.code, 0, secondDep.stderr);
        strictEqual(secondDep.stdout.trim(), '1');
    });
});

Deno.test({ name: 'cli stage: run handles concurrent stdio reads and writes', timeout: 20000 }, async () => {
    await withTempDir('cli-run-stdio', async (root) => {
        const stdinMain = join(root, 'stdin_read.ts');
        await Deno.writeTextFile(stdinMain, `
            const out = new Uint8Array(50);
            await Promise.all(Array.from({ length: 50 }, async (_, i) => {
                const buf = new Uint8Array(1);
                const n = await Deno.stdin.read(buf);
                if (n !== 1) throw new Error("bad read " + n);
                out[i] = buf[0];
            }));
            await Deno.stdout.write(out);
        `);
        const input = '01234567890123456789012345678901234567890123456789';
        const stdin = await runCnoWithInput(['run', stdinMain], input, root);
        strictEqual(stdin.code, 0, stdin.stderr);
        strictEqual(stdin.stdout, input);

        const stdoutMain = join(root, 'stdout_write.ts');
        await Deno.writeTextFile(stdoutMain, `
            const encoder = new TextEncoder();
            for (let i = 0; i < 25; i++) {
                await Promise.all([
                    Deno.stdout.write(encoder.encode("Hello, ")),
                    Deno.stdout.write(encoder.encode("world! " + i)),
                    Deno.stdout.write(encoder.encode("\\n")),
                ]);
            }
        `);
        const stdout = await runCno(['run', stdoutMain], root);
        strictEqual(stdout.code, 0, stdout.stderr);
        strictEqual(stdout.stdout.split(/\r?\n/).filter(Boolean).length, 25, stdout.stdout);

        const mixedMain = join(root, 'stdout_mixed.ts');
        await Deno.writeTextFile(mixedMain, `
            const encoder = new TextEncoder();
            for (let i = 0; i < 25; i++) {
                console.log("Hello");
                await Deno.stdout.write(encoder.encode("Hello\\n"));
            }
        `);
        const mixed = await runCno(['run', mixedMain], root);
        strictEqual(mixed.code, 0, mixed.stderr);
        strictEqual(mixed.stdout.trim().split(/\r?\n/).filter((line) => line === 'Hello').length, 50, mixed.stdout);
    });
});

Deno.test({ name: 'cli stage: run drains duplex stdio beyond the pipe buffer', timeout: 30000 }, async () => {
    await withTempDir('cli-stage-duplex', async (root) => {
        // A child that echoes input while both output pipes stream back: without
        // concurrent drainage the harness deadlocks once either pipe fills.
        const echoScript = join(root, 'echo.ts');
        await Deno.writeTextFile(echoScript, `
            const buffer = new Uint8Array(65536);
            let total = 0;
            for (;;) {
                const read = await Deno.stdin.read(buffer);
                if (read === null || read === 0) break;
                total += read;
                const chunk = buffer.slice(0, read);
                await Promise.all([Deno.stdout.write(chunk), Deno.stderr.write(chunk)]);
            }
            if (total === 0) throw new Error('empty input');
        `);
        const input = '0123456789abcdef'.repeat(64 * 1024); // 1 MiB per pipe.
        const result = await runCnoWithInput(['run', echoScript], input, root);
        strictEqual(result.code, 0, result.stderr);
        strictEqual(result.stdout, input);
        strictEqual(result.stderr, input);
    });
});
