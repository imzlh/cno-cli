import { deepStrictEqual, ok, strictEqual } from 'node:assert';
import { join } from 'node:path';
import { decodeUtf8 } from '../_helpers/bytes.ts';
import { withTempDir } from '../_helpers/temp.ts';

async function runCno(args: string[], cwd?: string, env?: Record<string, string>): Promise<{ code: number; stdout: string; stderr: string }> {
    const execPath = Deno.execPath().replace(/ \(deleted\)$/, '');
    const output = await new Deno.Command(execPath, {
        args,
        cwd,
        stdout: 'piped',
        stderr: 'piped',
        env: {
            CTS_SILENT: 'true',
            ...env,
        },
    }).output();
    return {
        code: output.code,
        stdout: decodeUtf8(output.stdout),
        stderr: decodeUtf8(output.stderr),
    };
}

async function runCnoWithInput(args: string[], input: string, cwd?: string): Promise<{ code: number; stdout: string; stderr: string }> {
    const execPath = Deno.execPath().replace(/ \(deleted\)$/, '');
    const child = new Deno.Command(execPath, {
        args,
        cwd,
        stdin: 'piped',
        stdout: 'piped',
        stderr: 'piped',
        env: {
            CTS_SILENT: 'true',
        },
    }).spawn();
    const writer = child.stdin.getWriter();
    await writer.write(new TextEncoder().encode(input));
    await writer.close();
    const output = await child.output();
    return {
        code: output.code,
        stdout: decodeUtf8(output.stdout),
        stderr: decodeUtf8(output.stderr),
    };
}

const ADD_WASM = new Uint8Array([
    0x00, 0x61, 0x73, 0x6d,
    0x01, 0x00, 0x00, 0x00,
    0x01, 0x07, 0x01, 0x60, 0x02, 0x7f, 0x7f, 0x01, 0x7f,
    0x03, 0x02, 0x01, 0x00,
    0x07, 0x07, 0x01, 0x03, 0x61, 0x64, 0x64, 0x00, 0x00,
    0x0a, 0x09, 0x01, 0x07, 0x00, 0x20, 0x00, 0x20, 0x01, 0x6a, 0x0b,
]);

async function writeCachedNpmPackage(
    cacheDir: string,
    name: string,
    version: string,
    pkg: Record<string, unknown>,
    files: Record<string, string>,
): Promise<string> {
    const slash = name.indexOf('/');
    const dir = name.startsWith('@') && slash !== -1
        ? join(cacheDir, 'npm', name.slice(0, slash), `${name.slice(slash + 1)}@${version}`)
        : join(cacheDir, 'npm', `${name}@${version}`);
    await Deno.mkdir(dir, { recursive: true });
    await Deno.writeTextFile(join(dir, 'package.json'), JSON.stringify({ name, version, ...pkg }));
    for (const [path, text] of Object.entries(files)) {
        const file = join(dir, path);
        await Deno.mkdir(join(file, '..'), { recursive: true });
        await Deno.writeTextFile(file, text);
    }
    return dir;
}

async function writeCachedNpmMeta(
    cacheDir: string,
    name: string,
    versions: Record<string, Record<string, unknown>> = {},
    tags: Record<string, string> = {},
): Promise<void> {
    const dir = join(cacheDir, 'npm', name);
    await Deno.mkdir(dir, { recursive: true });
    await Deno.writeTextFile(join(dir, 'meta.json'), JSON.stringify({
        versions,
        'dist-tags': tags,
    }));
    await Deno.writeTextFile(join(dir, 'meta.json.ts'), String(Date.now()));
}

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
        strictEqual(result.code, 0, result.stderr);
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
        await Deno.writeTextFile(main, `
            if (!import.meta.main) throw new Error("entry must be main");
            console.log("META:" + JSON.stringify({
                url: import.meta.url.startsWith("file://"),
                filename: import.meta.filename.endsWith("/main.ts"),
                dirname: import.meta.dirname.endsWith(${JSON.stringify(root)}),
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

Deno.test({ name: 'cli stage: run detects ESM syntax in package commonjs js files', timeout: 15000 }, async () => {
    await withTempDir('cli-run-package-type-commonjs', async (root) => {
        await Deno.writeTextFile(join(root, 'package.json'), JSON.stringify({ type: 'commonjs' }));
        await Deno.writeTextFile(join(root, 'add.js'), `
            module.exports.add = function (a, b) {
                return a + b;
            };
        `);

        const cjs = join(root, 'main_cjs.js');
        await Deno.writeTextFile(cjs, `
            const { add } = require("./add");
            console.log(add(1, 2));
        `);
        const cjsRun = await runCno(['run', cjs], root);
        strictEqual(cjsRun.code, 0, cjsRun.stderr);
        strictEqual(cjsRun.stdout.trim(), '3');

        const esm = join(root, 'main_esm.js');
        await Deno.writeTextFile(esm, `
            import { add } from "./add.js";
            console.log(add(1, 2));
        `);
        const esmRun = await runCno(['run', esm], root);
        strictEqual(esmRun.code, 0, esmRun.stderr);
        strictEqual(esmRun.stdout.trim(), '3');

        const notImportMeta = join(root, 'not_import_meta.js');
        await Deno.writeTextFile(notImportMeta, `
            try {
                console.log(test.import.meta.url);
            } catch {
            }
            console.log(require("./add").add(1, 2));
        `);
        const notMetaRun = await runCno(['run', notImportMeta], root);
        strictEqual(notMetaRun.code, 0, notMetaRun.stderr);
        strictEqual(notMetaRun.stdout.trim(), '3');

        const tla = join(root, 'tla.js');
        await Deno.writeTextFile(tla, `
            await new Promise((resolve) => resolve());
            console.log("loaded");
        `);
        const tlaRun = await runCno(['run', tla], root);
        strictEqual(tlaRun.code, 0, tlaRun.stderr);
        strictEqual(tlaRun.stdout.trim(), 'loaded');
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
        const jsReexport = await runCno(['run', join(root, 'via_js.ts')], root);
        strictEqual(jsReexport.code, 0, jsReexport.stderr);
        strictEqual(jsReexport.stdout.trim(), 'true');

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
        const jsEntry = await runCno(['run', join(root, 'js_entry.js')], root);
        strictEqual(jsEntry.code, 0, jsEntry.stderr);
        deepStrictEqual(jsEntry.stdout.trim().split(/\r?\n/), ['Hello', 'success']);

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
        `);

        const basic = await runCno(['run', '--env=./env', main], root);
        strictEqual(basic.code, 0, basic.stderr);
        deepStrictEqual(basic.stdout.trim().split(/\r?\n/), [
            'BAR',
            'ANOTHER_BAR',
            'First Line',
            'Second Line',
        ]);

        const multiple = await runCno(['run', '--env=./env', '--env=./env_one', '--env-file=./env_two', main], root);
        strictEqual(multiple.code, 0, multiple.stderr);
        deepStrictEqual(multiple.stdout.trim().split(/\r?\n/), [
            'OVERRIDEN_BY_ENV_TWO',
            'OVERRIDEN_BY_ENV_ONE',
            'First Line',
            'Second Line',
        ]);

        const missing = await runCno(['run', '--env=./missing_env', main], root);
        strictEqual(missing.code, 0, missing.stderr);
        ok(missing.stderr.includes('Warning Failed to load env file'), missing.stderr);
        deepStrictEqual(missing.stdout.trim().split(/\r?\n/), ['undefined', 'undefined', 'undefined']);

        const bad = await runCno(['run', '--env=./bad_env', main], root);
        strictEqual(bad.code, 0, bad.stderr);
        ok(bad.stderr.includes('Warning Failed to parse env file'), bad.stderr);
        deepStrictEqual(bad.stdout.trim().split(/\r?\n/), ['undefined', 'undefined', 'undefined']);
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

        const ordered = await runCno(['run', '--preload', './preload.ts', '--import', './import.ts', main], root);
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

        const result = await runCno(['run', '--require', './require3.cjs', main], root, {
            NODE_OPTIONS: '--require ./require1.cjs -r ./require2.cjs',
        });
        strictEqual(result.code, 0, result.stderr);
        deepStrictEqual(result.stdout.trim().split(/\r?\n/), [
            'require1.cjs',
            'require2.cjs',
            'require3.cjs',
            'main.ts',
        ]);
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
                firstFilename: globalThis.__first_filename__.endsWith("/require_first.js"),
                secondFilename: globalThis.__second_filename__.endsWith("/require_second.js"),
                firstDirname: globalThis.__first_dirname__ === Deno.cwd(),
                secondDirname: globalThis.__second_dirname__ === Deno.cwd(),
            }));
            console.log("main_multiple.ts finished");
        `);

        const result = await runCno(['run', '--require', './require_first.js', '--require', './require_second.js', main], root);
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
        const privatePresence = join(root, 'private_field_presence.ts');
        await Deno.writeTextFile(privatePresence, `
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
            const b = new Person("bob");
            const c = new Person("alice");
            console.log(a.equals(b));
            console.log(a.equals(c));
        `);
        const presence = await runCno(['run', privatePresence], root);
        strictEqual(presence.code, 0, presence.stderr);
        deepStrictEqual(presence.stdout.trim().split(/\r?\n/), ['false', 'true']);

        const privateFields = join(root, 'es_private_fields.js');
        await Deno.writeTextFile(privateFields, `
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
        `);
        const fields = await runCno(['run', privateFields], root);
        strictEqual(fields.code, 0, fields.stderr);
        strictEqual(fields.stdout.trim(), 'PRIVATE');

        const weakRef = join(root, 'weakref.ts');
        await Deno.writeTextFile(weakRef, `
            console.log(typeof WeakRef, typeof FinalizationRegistry);
        `);
        const weak = await runCno(['run', weakRef], root);
        strictEqual(weak.code, 0, weak.stderr);
        strictEqual(weak.stdout.trim(), 'function function');
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

        const doubleAwait = join(root, 'double_await.ts');
        await Deno.writeTextFile(doubleAwait, `
            const currDirInfo = await Deno.stat(".");
            const parentDirInfo = await Deno.stat("..");
            console.log(currDirInfo.isDirectory);
            console.log(parentDirInfo.isFile);
        `);
        const awaited = await runCno(['run', doubleAwait], root);
        strictEqual(awaited.code, 0, awaited.stderr);
        deepStrictEqual(awaited.stdout.trim().split(/\r?\n/), ['true', 'false']);

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
        const caught = await runCno(['run', asyncCatch], root);
        strictEqual(caught.code, 0, caught.stderr);
        deepStrictEqual(caught.stdout.trim().split(/\r?\n/), [
            'before await fn()',
            'catch',
            'after try-catch',
        ]);
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

Deno.test({ name: 'cli stage: test discovers nested tests and reports failures with exit code 1', timeout: 15000 }, async () => {
    await withTempDir('cli-test', async (root) => {
        const nested = join(root, 'nested');
        await Deno.mkdir(nested);
        await Deno.writeTextFile(join(nested, 'sample.test.ts'), `
            import { strictEqual } from 'node:assert';

            Deno.test('sample pass', () => strictEqual(1 + 1, 2));
        `);
        await Deno.writeTextFile(join(root, 'ignored.ts'), `
            throw new Error('should not be discovered');
        `);

        const pass = await runCno(['test', '--concurrency', '1', root], root);
        strictEqual(pass.code, 0, pass.stderr);
        ok(pass.stdout.includes('PASS'), pass.stdout);
        ok(pass.stdout.includes('sample.test.ts'), pass.stdout);
        ok(pass.stdout.includes('✔ 1/1'), pass.stdout);
        ok(!pass.stderr.includes('unknown flag --concurrency'), pass.stderr);

        const failing = join(root, 'failing.test.ts');
        await Deno.writeTextFile(failing, `
            Deno.test('sample fail', () => {
                throw new Error('expected cli failure');
            });
        `);
        const fail = await runCno(['test', failing], root);
        strictEqual(fail.code, 1);
        ok(fail.stdout.includes('FAIL') || fail.stderr.includes('sample fail'), fail.stdout + fail.stderr);
        ok(fail.stdout.includes('✖ 0/1') || fail.stdout.includes('0/1'), fail.stdout);
    });
});

Deno.test({ name: 'cli stage: test supports filter fail-fast and permit-no-files', timeout: 20000 }, async () => {
    await withTempDir('cli-test-flags', async (root) => {
        const empty = join(root, 'empty');
        await Deno.mkdir(empty);

        const noFiles = await runCno(['test'], empty);
        strictEqual(noFiles.code, 1);
        ok(noFiles.stderr.includes('No test modules found'), noFiles.stdout + noFiles.stderr);

        const permitNoFiles = await runCno(['test', '--permit-no-files'], empty);
        strictEqual(permitNoFiles.code, 0, permitNoFiles.stderr);
        ok(permitNoFiles.stdout.includes('0/0'), permitNoFiles.stdout);

        const filterDir = join(root, 'filter');
        await Deno.mkdir(filterDir);
        for (const name of ['a_test.ts', 'b_test.ts', 'c_test.ts']) {
            await Deno.writeTextFile(join(filterDir, name), `
                Deno.test('foo', () => {});
                Deno.test('bar', () => { throw new Error('bar should be filtered'); });
            `);
        }
        const filtered = await runCno(['test', '--filter=foo', filterDir], root);
        strictEqual(filtered.code, 0, filtered.stderr);
        ok(filtered.stdout.includes('✔ 3/3'), filtered.stdout);
        ok(!filtered.stderr.includes('bar should be filtered'), filtered.stdout + filtered.stderr);

        const failFastDir = join(root, 'fail-fast');
        await Deno.mkdir(failFastDir);
        const first = join(failFastDir, 'first_test.ts');
        const second = join(failFastDir, 'second_test.ts');
        await Deno.writeTextFile(first, `
            Deno.test('first failure', () => { throw new Error('first boom'); });
            Deno.test('second in same file', () => { throw new Error('should not run same file'); });
        `);
        await Deno.writeTextFile(second, `
            Deno.test('other file failure', () => { throw new Error('should not run other file'); });
        `);

        const failed = await runCno(['test', '--fail-fast', '--concurrency=4', first, second], root);
        strictEqual(failed.code, 1);
        ok(failed.stderr.includes('first failure') || failed.stdout.includes('first failure'), failed.stdout + failed.stderr);
        ok(!failed.stderr.includes('should not run same file'), failed.stdout + failed.stderr);
        ok(!failed.stderr.includes('should not run other file'), failed.stdout + failed.stderr);
    });
});

Deno.test({ name: 'cli stage: test accepts default TypeScript extensionless and --ext entries', timeout: 20000 }, async () => {
    await withTempDir('cli-test-default-ts', async (root) => {
        const extensionless = join(root, 'extensionless');
        await Deno.writeTextFile(extensionless, `
            Deno.test(function foo() {
                const x: string = "foo";
                if (x !== "foo") throw new Error("bad extensionless");
            });
        `);
        const extlessTest = await runCno(['test', '--concurrency=1', extensionless], root);
        strictEqual(extlessTest.code, 0, extlessTest.stderr);
        ok(extlessTest.stdout.includes('PASS'), extlessTest.stdout);
        ok(extlessTest.stdout.includes('extensionless'), extlessTest.stdout);

        const asTsJs = join(root, 'as_ts.js');
        await Deno.writeTextFile(asTsJs, `
            Deno.test(function foo() {
                const x: string = "foo";
                if (x !== "foo") throw new Error("bad ext flag");
            });
        `);
        const extFlag = await runCno(['test', '--concurrency=1', '--ext=ts', asTsJs], root);
        strictEqual(extFlag.code, 0, extFlag.stderr);
        ok(extFlag.stdout.includes('PASS'), extFlag.stdout);
        ok(extFlag.stdout.includes('as_ts.js'), extFlag.stdout);
        ok(!extFlag.stderr.includes('unknown flag --ext'), extFlag.stderr);
    });
});

Deno.test({ name: 'cli stage upstream: CJS re-export analysis reports deterministic first missing dependency', timeout: 15000 }, async () => {
    await withTempDir('cli-cjs-analysis-multiple-errors', async (root) => {
        const pkgDir = join(root, 'node_modules', 'package');
        await Deno.mkdir(pkgDir, { recursive: true });
        await Deno.writeTextFile(join(pkgDir, 'package.json'), JSON.stringify({
            name: 'package',
            version: '1.0.0',
        }));
        await Deno.writeTextFile(join(pkgDir, 'a.js'), `
            var external001 = require("./not_exists.js");
            Object.keys(external001).forEach(function(key) {
                exports[key] = external001[key];
            });
        `);
        await Deno.writeTextFile(join(pkgDir, 'b.js'), `
            var external001 = require("./not_exists2.js");
            Object.keys(external001).forEach(function(key) {
                exports[key] = external001[key];
            });
        `);
        await Deno.writeTextFile(join(pkgDir, 'index.js'), `
            var external001 = require("./a.js");
            Object.keys(external001).forEach(function(key) {
                exports[key] = external001[key];
            });
            var external002 = require("./b.js");
            Object.keys(external002).forEach(function(key) {
                exports[key] = external002[key];
            });
        `);
        await Deno.writeTextFile(join(root, 'main.ts'), `
            import * as pkg from "package";
            console.log(pkg);
        `);

        const result = await runCno(['run', 'main.ts'], root);
        strictEqual(result.code, 1);
        ok(result.stderr.includes('not_exists.js'), result.stderr);
        ok(result.stderr.includes('/package/a.js'), result.stderr);
        ok(!result.stderr.includes('not_exists2.js'), result.stderr);
    });
});

Deno.test({ name: 'cli stage upstream: spawned package entry keeps npm parent resolution state', timeout: 20000 }, async () => {
    await withTempDir('cli-spawn-keeps-npm-state', async (root) => {
        const pkgDir = join(root, 'node_modules', '@denotest', 'spawn-keeps-npm-state');
        const depDir = join(pkgDir, 'node_modules', '@denotest', 'add');
        await Deno.mkdir(depDir, { recursive: true });
        await Deno.writeTextFile(join(pkgDir, 'package.json'), JSON.stringify({
            name: '@denotest/spawn-keeps-npm-state',
            version: '1.0.0',
            type: 'module',
            exports: './index.js',
            dependencies: { '@denotest/add': '*' },
        }));
        await Deno.writeTextFile(join(pkgDir, 'index.js'), `
            import { spawnSync } from "node:child_process";
            import { fileURLToPath } from "node:url";

            const result = spawnSync(process.execPath, [fileURLToPath(import.meta.resolve("./spawned.js"))], {
                stdio: "inherit",
            });
            if (result.error) {
                console.error("Failed:", result.error);
                process.exit(1);
            }
            if (result.status !== 0) process.exit(result.status);
        `);
        await Deno.writeTextFile(join(pkgDir, 'spawned.js'), `
            import { add } from "@denotest/add";
            console.log(add(1, 2));
        `);
        await Deno.writeTextFile(join(depDir, 'package.json'), JSON.stringify({
            name: '@denotest/add',
            version: '1.0.0',
            main: './index.js',
        }));
        await Deno.writeTextFile(join(depDir, 'index.js'), 'exports.add = (a, b) => a + b;\n');
        await Deno.writeTextFile(join(root, 'main.ts'), 'import "@denotest/spawn-keeps-npm-state";\n');

        const result = await runCno(['run', 'main.ts'], root);
        strictEqual(result.code, 0, result.stderr);
        strictEqual(result.stdout.trim(), '3');
    });
});

Deno.test({ name: 'cli stage upstream npm: run resolves package bin entrypoints', timeout: 20000 }, async () => {
    await withTempDir('cli-npm-run-bin', async (root) => {
        const cacheDir = join(root, 'cache');
        await writeCachedNpmPackage(cacheDir, '@denotest/bin', '1.0.0', {
            bin: {
                'cli-esm': './cli.mjs',
                'cli-no-ext': './cli-no-ext',
                'cli-cjs': './cli-cjs.js',
            },
        }, {
            'cli-cjs.js': [
                'for (const arg of process.argv.slice(2)) console.log(arg);',
            ].join('\n'),
            'cli.mjs': [
                'for (const arg of process.argv.slice(2)) console.log(arg);',
            ].join('\n'),
            'cli-no-ext': [
                'for (const arg of process.argv.slice(2)) console.log(arg);',
            ].join('\n'),
        });
        await writeCachedNpmPackage(cacheDir, '@denotest/special-chars-in-bin-name', '1.0.0', {
            type: 'module',
            bin: { '\\foo"': './main.mjs' },
        }, {
            'main.mjs': [
                'for (const arg of process.argv.slice(2)) console.log(arg);',
            ].join('\n'),
        });
        await writeCachedNpmPackage(cacheDir, '@denotest/single-bin', '1.0.0', {
            bin: './main.mjs',
        }, {
            'main.mjs': 'console.log("single", process.argv.slice(2).join(","));\n',
        });
        await writeCachedNpmPackage(cacheDir, '@denotest/direct-file', '0.6.0', {}, {
            'cli-cjs.js': [
                'for (const arg of process.argv.slice(2)) console.log(arg);',
            ].join('\n'),
        });
        await writeCachedNpmPackage(cacheDir, '@denotest/esm-basic', '1.0.0', {
            type: 'module',
            main: './main.mjs',
        }, {
            'main.mjs': 'console.log("not a bin");\n',
        });

        const cacheFlag = `--cache-dir=${cacheDir}`;
        for (const spec of [
            'npm:@denotest/bin@1.0.0/cli-cjs',
            'npm:@denotest/bin@1.0.0/cli-esm',
            'npm:@denotest/bin@1.0.0/cli-no-ext',
            'npm:@denotest/special-chars-in-bin-name@1.0.0/\\foo"',
            'npm:@denotest/direct-file@0.6.0/cli-cjs.js',
        ]) {
            const result = await runCno(['run', cacheFlag, spec, 'this', 'is', 'a', 'test'], root);
            strictEqual(result.code, 0, `${spec}\n${result.stderr}`);
            deepStrictEqual(result.stdout.trim().split(/\r?\n/), ['this', 'is', 'a', 'test'], `${spec}\n${result.stdout}`);
        }

        const single = await runCno(['run', cacheFlag, 'npm:@denotest/single-bin@1.0.0', 'x', 'y'], root);
        strictEqual(single.code, 0, single.stderr);
        strictEqual(single.stdout.trim(), 'single x,y');

        const noBin = await runCno(['run', cacheFlag, 'npm:@denotest/esm-basic@1.0.0'], root);
        strictEqual(noBin.code, 1);
        ok(noBin.stderr.includes('no bin entrypoint'), noBin.stderr);
    });
});

Deno.test({ name: 'cli stage: exec resolves bins from CTS cache, not local node_modules', timeout: 20000 }, async () => {
    await withTempDir('cli-exec-cache-bin', async (root) => {
        const cacheDir = join(root, 'cache');
        await writeCachedNpmPackage(cacheDir, 'tool', '1.0.0', {
            bin: { tool: './cli.mjs' },
        }, {
            'cli.mjs': 'console.log("cache");\n',
        });
        await Deno.mkdir(join(root, 'node_modules', '.bin'), { recursive: true });
        await Deno.writeTextFile(join(root, 'node_modules', '.bin', 'tool'), '#!/bin/sh\necho local\n');

        const result = await runCno(['exec', `--cache-dir=${cacheDir}`, 'tool'], root);
        strictEqual(result.code, 0, result.stderr);
        strictEqual(result.stdout.trim(), 'cache');
    });
});

Deno.test({ name: 'cli stage upstream npm: dynamic import from npm can load local TS URLs', timeout: 20000 }, async () => {
    await withTempDir('cli-npm-dynamic-import-local-ts', async (root) => {
        const cacheDir = join(root, 'cache');
        await writeCachedNpmPackage(cacheDir, '@denotest/dynamic-import', '1.0.0', {
            type: 'module',
        }, {
            'index.js': 'export function dynamicImport(url) { return import(url); }\n',
        });
        await Deno.writeTextFile(join(root, 'add.ts'), 'export function add(a: number, b: number) { return a + b; }\n');
        await Deno.writeTextFile(join(root, 'subtract.mts'), 'export function subtract(a: number, b: number) { return a - b; }\n');
        await Deno.writeTextFile(join(root, 'main.ts'), `
            import { dynamicImport } from "npm:@denotest/dynamic-import@1.0.0";
            const { add } = await dynamicImport(new URL("./add.ts", import.meta.url));
            const { subtract } = await dynamicImport(new URL("./subtract.mts", import.meta.url));
            console.log(add(1, 2));
            console.log(subtract(1, 2));
        `);

        const result = await runCno(['run', `--cache-dir=${cacheDir}`, 'main.ts'], root);
        strictEqual(result.code, 0, result.stderr);
        deepStrictEqual(result.stdout.trim().split(/\r?\n/), ['3', '-1']);
    });
});

Deno.test({ name: 'cli stage upstream npm: non-analyzable dynamic import can add npm deps', timeout: 20000 }, async () => {
    await withTempDir('cli-npm-dynamic-import-add-dep', async (root) => {
        const cacheDir = join(root, 'cache');
        await writeCachedNpmPackage(cacheDir, '@denotest/add', '1.0.0', {}, {
            'index.js': 'module.exports.add = (a, b) => a + b;\n',
        });
        await writeCachedNpmPackage(cacheDir, '@denotest/subtract', '1.0.0', {}, {
            'index.js': 'module.exports.subtract = (a, b) => a - b;\n',
        });
        await Deno.writeTextFile(join(root, 'other.ts'), 'export * from "npm:@denotest/subtract@1.0.0";\n');
        await Deno.writeTextFile(join(root, 'main.ts'), `
            import { add } from "npm:@denotest/add@1.0.0";
            console.log(add(1, 2));
            const fileName = "other.ts";
            const { subtract } = await import("./" + fileName);
            console.log(subtract(3, 2));
        `);

        const result = await runCno(['run', `--cache-dir=${cacheDir}`, 'main.ts'], root);
        strictEqual(result.code, 0, result.stderr);
        deepStrictEqual(result.stdout.trim().split(/\r?\n/), ['3', '1']);
    });
});

Deno.test({ name: 'cli stage upstream npm: direct non-analyzable dynamic npm import resolves cached package', timeout: 20000 }, async () => {
    await withTempDir('cli-npm-dynamic-import-specifier', async (root) => {
        const cacheDir = join(root, 'cache');
        await writeCachedNpmPackage(cacheDir, '@denotest/add', '1.0.0', {
            type: 'module',
        }, {
            'index.js': 'export function add(a, b) { return a + b; }\n',
        });
        await Deno.writeTextFile(join(root, 'main.ts'), `
            const specifier = "npm:@denotest/add@1.0.0";
            const { add } = await import(specifier);
            console.log(add(1, 2));
        `);

        const result = await runCno(['run', `--cache-dir=${cacheDir}`, 'main.ts'], root);
        strictEqual(result.code, 0, result.stderr);
        strictEqual(result.stdout.trim(), '3');
    });
});

Deno.test({ name: 'cli stage upstream npm: dynamic import reuses the same cached npm package instance', timeout: 20000 }, async () => {
    await withTempDir('cli-npm-dynamic-import-reuse-package', async (root) => {
        const cacheDir = join(root, 'cache');
        await writeCachedNpmPackage(cacheDir, '@denotest/counter', '1.0.0', {
            type: 'module',
        }, {
            'index.js': [
                'let value = 0;',
                'export function setValue(next) { value = next; }',
                'export function getValue() { return value; }',
            ].join('\n'),
        });
        await Deno.writeTextFile(join(root, 'other.ts'), `
            import { getValue, setValue } from "npm:@denotest/counter@1.0.0";
            console.log("other-before", getValue());
            setValue(2);
        `);
        await Deno.writeTextFile(join(root, 'main.ts'), `
            import { getValue, setValue } from "npm:@denotest/counter@1.0.0";
            setValue(1);
            const fileName = "other.ts";
            await import("./" + fileName);
            console.log("main-after", getValue());
        `);

        const result = await runCno(['run', `--cache-dir=${cacheDir}`, '--reload', 'main.ts'], root);
        strictEqual(result.code, 0, result.stderr);
        deepStrictEqual(result.stdout.trim().split(/\r?\n/), ['other-before 1', 'main-after 2']);
    });
});

Deno.test({ name: 'cli stage upstream npm: common CJS package features resolve from cache', timeout: 20000 }, async () => {
    await withTempDir('cli-npm-cjs-package-features', async (root) => {
        const cacheDir = join(root, 'cache');
        const setup = await runCno(['setup', `--cache-dir=${cacheDir}`]);
        strictEqual(setup.code, 0, setup.stderr);

        await writeCachedNpmPackage(cacheDir, '@denotest/specifier-two-slashes', '1.0.0', {
            type: 'module',
        }, {
            'index.js': 'export function add(a, b) { return a + b; }\n',
        });
        await writeCachedNpmMeta(cacheDir, '@denotest/specifier-two-slashes', {
            '1.0.0': {
                version: '1.0.0',
                dist: { tarball: 'https://example.invalid/specifier-two-slashes-1.0.0.tgz' },
            },
        }, { latest: '1.0.0' });
        await writeCachedNpmPackage(cacheDir, 'globals', '13.17.0', {}, {
            'index.js': 'module.exports = require("./globals.json");\n',
            'globals.json': JSON.stringify({ devtools: { Chrome: true } }),
        });
        await writeCachedNpmPackage(cacheDir, '@denotest/cjs-pkg-imports', '1.0.0', {
            imports: {
                '#value': './value.js',
                '#nested/*': './nested/*.js',
            },
        }, {
            'index.js': [
                'const value = require("#value");',
                'const nested = require("#nested/name");',
                'module.exports = { value: value.value, nested: nested.name };',
            ].join('\n'),
            'value.js': 'exports.value = 5;\n',
            'nested/name.js': 'exports.name = "nested";\n',
        });
        await writeCachedNpmPackage(cacheDir, '@denotest/builtin-module-module', '1.0.0', {}, {
            'index.js': [
                'const moduleBuiltin = require("module");',
                'exports.createRequire = typeof moduleBuiltin.createRequire;',
                'exports.Module = typeof moduleBuiltin.Module;',
                'exports.same = moduleBuiltin.Module === moduleBuiltin.default?.Module || moduleBuiltin.Module === moduleBuiltin;',
            ].join('\n'),
        });
        await Deno.writeTextFile(join(root, 'main.ts'), `
            import { add } from "npm:@denotest/specifier-two-slashes";
            import globals from "npm:globals@13.17.0";
            import importsPkg from "npm:@denotest/cjs-pkg-imports@1.0.0";
            import builtin from "npm:@denotest/builtin-module-module@1.0.0";
            console.log(add(1, 2));
            console.log(globals.devtools.Chrome);
            console.log(importsPkg.value, importsPkg.nested);
            console.log(builtin.createRequire, builtin.Module, builtin.same);
        `);

        const result = await runCno(['run', `--cache-dir=${cacheDir}`, 'main.ts'], root);
        strictEqual(result.code, 0, result.stderr);
        deepStrictEqual(result.stdout.trim().split(/\r?\n/), [
            '3',
            'true',
            '5 nested',
            'function function true',
        ]);
    });
});

Deno.test({ name: 'cli stage upstream npm: CJS packages can require deps subpaths and ESM', timeout: 20000 }, async () => {
    await withTempDir('cli-npm-cjs-deps-subpaths-esm', async (root) => {
        const cacheDir = join(root, 'cache');
        await writeCachedNpmPackage(cacheDir, '@denotest/dep', '1.0.0', {}, {
            'index.js': 'exports.root = "dep-root";\n',
            'sub/path.js': 'exports.sub = require("..").root + ":sub";\n',
        });
        await writeCachedNpmPackage(cacheDir, '@denotest/cjs-with-deps', '1.0.0', {
            dependencies: { '@denotest/dep': '1.0.0' },
        }, {
            'index.js': [
                'exports.depRoot = require("@denotest/dep").root;',
                'exports.depSub = require("@denotest/dep/sub/path").sub;',
            ].join('\n'),
        });
        await writeCachedNpmPackage(cacheDir, '@denotest/cjs-require-esm', '1.0.0', {}, {
            'index.js': [
                'exports.Test = require("./esm.mjs");',
                'exports.local = require("./folder/entry").value;',
            ].join('\n'),
            'esm.mjs': 'export class Test { static value = 42; }\n',
            'folder/entry.js': 'exports.value = require("..").Test.Test.value;\n',
        });
        await Deno.writeTextFile(join(root, 'main.ts'), `
            import withDeps from "npm:@denotest/cjs-with-deps@1.0.0";
            import * as requireEsm from "npm:@denotest/cjs-require-esm@1.0.0";
            console.log(withDeps.depRoot);
            console.log(withDeps.depSub);
            console.log(requireEsm.Test.Test.value);
            console.log(requireEsm.default.Test.Test.value);
            console.log(requireEsm["module.exports"].Test.Test.value);
            console.log(requireEsm.local);
        `);

        const result = await runCno(['run', `--cache-dir=${cacheDir}`, 'main.ts'], root);
        strictEqual(result.code, 0, result.stderr);
        deepStrictEqual(result.stdout.trim().split(/\r?\n/), [
            'dep-root',
            'dep-root:sub',
            '42',
            '42',
            '42',
            '42',
        ]);
    });
});

Deno.test({ name: 'cli stage upstream npm: package createRequire validates inputs and loads package files', timeout: 20000 }, async () => {
    await withTempDir('cli-npm-create-require', async (root) => {
        const cacheDir = join(root, 'cache');
        const setup = await runCno(['setup', `--cache-dir=${cacheDir}`]);
        strictEqual(setup.code, 0, setup.stderr);

        await writeCachedNpmPackage(cacheDir, '@denotest/create-require', '1.0.0', {
            type: 'module',
        }, {
            'index.js': [
                'import { createRequire } from "node:module";',
                'const reqFromUrl = createRequire(import.meta.url);',
                'const reqFromUrlObject = createRequire(new URL(import.meta.url));',
                'console.log(typeof reqFromUrl);',
                'console.log(reqFromUrl("./fixture.cjs").value);',
                'console.log(reqFromUrlObject("./package.json").name);',
                'for (const value of ["https://example.com/", 1, "foo", "./foo"]) {',
                '  try { createRequire(value); } catch (err) { console.log(err instanceof TypeError, String(err).includes("file URL object")); }',
                '}',
            ].join('\n'),
            'fixture.cjs': 'exports.value = "fixture";\n',
        });
        await Deno.writeTextFile(join(root, 'main.ts'), 'import "npm:@denotest/create-require@1.0.0";\n');

        const result = await runCno(['run', `--cache-dir=${cacheDir}`, 'main.ts'], root);
        strictEqual(result.code, 0, result.stderr);
        deepStrictEqual(result.stdout.trim().split(/\r?\n/), [
            'function',
            'fixture',
            '@denotest/create-require',
            'true true',
            'true true',
            'true true',
            'true true',
        ]);
    });
});

Deno.test({ name: 'cli stage upstream npm: CJS and ESM package condition interop matches runtime entry', timeout: 20000 }, async () => {
    await withTempDir('cli-npm-dual-condition-interop', async (root) => {
        const cacheDir = join(root, 'cache');
        await writeCachedNpmPackage(cacheDir, '@denotest/dual-cjs-esm', '1.0.0', {
            type: 'module',
            exports: {
                '.': {
                    import: './esm.js',
                    require: './cjs.cjs',
                },
            },
        }, {
            'esm.js': 'export function getKind() { return "esm"; }\n',
            'cjs.cjs': 'exports.getKind = () => "cjs";\n',
        });
        await writeCachedNpmPackage(cacheDir, '@denotest/cjs-import-dual', '1.0.0', {
            dependencies: { '@denotest/dual-cjs-esm': '1.0.0' },
        }, {
            'index.js': 'module.exports = require("@denotest/dual-cjs-esm");\n',
        });
        await writeCachedNpmMeta(cacheDir, '@denotest/cjs-import-dual', {
            '1.0.0': {
                version: '1.0.0',
                dist: { tarball: 'https://example.invalid/cjs-import-dual-1.0.0.tgz' },
            },
        }, { latest: '1.0.0' });
        await writeCachedNpmPackage(cacheDir, '@denotest/cjs-default-export', '1.0.0', {}, {
            'index.js': [
                'exports.default = () => 1;',
                'exports.named = () => 2;',
                'exports.MyClass = class MyClass { static someStaticMethod() { return "static method"; } };',
            ].join('\n'),
        });
        await writeCachedNpmPackage(cacheDir, '@denotest/esm-import-cjs-default', '1.0.0', {
            type: 'module',
            dependencies: { '@denotest/cjs-default-export': '1.0.0' },
        }, {
            'index.js': [
                'import cjsDefault from "@denotest/cjs-default-export";',
                'export default function getValue() { return cjsDefault.default() + 4; }',
            ].join('\n'),
        });
        await Deno.writeTextFile(join(root, 'main.ts'), `
            import { getKind } from "npm:@denotest/cjs-import-dual@1";
            import cjsDefault, { MyClass, named } from "npm:@denotest/cjs-default-export@1.0.0";
            import * as cjsNamespace from "npm:@denotest/cjs-default-export@1.0.0";
            import esmDefault from "npm:@denotest/esm-import-cjs-default@1.0.0";
            console.log(getKind());
            console.log(cjsDefault.default(), named(), MyClass.someStaticMethod());
            console.log(cjsNamespace.default.default(), cjsNamespace["module.exports"].named());
            console.log(esmDefault());
        `);

        const result = await runCno(['run', `--cache-dir=${cacheDir}`, 'main.ts'], root);
        strictEqual(result.code, 0, result.stderr);
        deepStrictEqual(result.stdout.trim().split(/\r?\n/), [
            'cjs',
            '1 2 static method',
            '1 2',
            '5',
        ]);
    });
});

Deno.test({ name: 'cli stage upstream npm: dynamic dependency resolution failures are catchable', timeout: 20000 }, async () => {
    await withTempDir('cli-npm-dynamic-resolution-failure', async (root) => {
        const cacheDir = join(root, 'cache');
        await writeCachedNpmPackage(cacheDir, '@denotest/esm-basic', '1.0.0', {
            type: 'module',
        }, {
            'index.js': 'export const ok = true;\n',
        });
        await writeCachedNpmMeta(cacheDir, '@denotest/esm-basic', {
            '1.0.0': {
                version: '1.0.0',
                dist: { tarball: 'https://example.invalid/esm-basic-1.0.0.tgz' },
            },
        }, { latest: '1.0.0' });
        await writeCachedNpmPackage(cacheDir, '@denotest/dep-cannot-parse', '1.0.0', {
            type: 'module',
        }, {
            'index.js': 'await import("npm:@denotest/esm-basic@unknown-scheme:unknown");\n',
        });
        await Deno.writeTextFile(join(root, 'main.ts'), `
            console.log("Hi");
            try {
                await import("npm:@denotest/dep-cannot-parse@1.0.0");
                console.log("UNREACHABLE");
            } catch (err) {
                console.log(err instanceof Error);
                console.log(String(err).includes("@denotest/esm-basic"));
            }
            console.log("Bye");
        `);

        const result = await runCno(['run', `--cache-dir=${cacheDir}`, 'main.ts'], root);
        strictEqual(result.code, 0, result.stderr);
        deepStrictEqual(result.stdout.trim().split(/\r?\n/), ['Hi', 'true', 'true', 'Bye']);
    });
});

Deno.test({ name: 'cli stage upstream npm: package code can exec bundled cno and preserve globals', timeout: 20000 }, async () => {
    await withTempDir('cli-npm-exec-and-globals', async (root) => {
        const cacheDir = join(root, 'cache');
        const setup = await runCno(['setup', `--cache-dir=${cacheDir}`]);
        strictEqual(setup.code, 0, setup.stderr);

        await writeCachedNpmPackage(cacheDir, '@denotest/exec-file', '1.0.0', {}, {
            'index.js': [
                'const { execFileSync } = require("node:child_process");',
                'const exe = process.execPath.replace(/ \\\\(deleted\\\\)$/, "");',
                'const out = execFileSync(exe, ["eval", "-p", "\\"Hello, world!\\""], { encoding: "utf8" });',
                'console.log(out.trim());',
            ].join('\n'),
        });
        await writeCachedNpmPackage(cacheDir, '@denotest/globals', '1.0.0', {}, {
            'index.js': [
                'exports.globalIsGlobalThis = global === globalThis;',
                'exports.processIsGlobal = process === globalThis.process;',
                'exports.execArgvIsArray = Array.isArray(process.execArgv);',
                'exports.getFoo = () => globalThis.foo;',
                'exports.ownKeysIncludeConsole = () => Reflect.ownKeys(globalThis).includes("console");',
            ].join('\n'),
        });
        await Deno.writeTextFile(join(root, 'main.ts'), `
            import "npm:@denotest/exec-file@1.0.0";
            import * as globals from "npm:@denotest/globals@1.0.0";
            globalThis.foo = "bar";
            console.log(globals.globalIsGlobalThis);
            console.log(globals.processIsGlobal);
            console.log(globals.execArgvIsArray);
            console.log(globals.getFoo());
            console.log(globals.ownKeysIncludeConsole());
        `);

        const result = await runCno(['run', `--cache-dir=${cacheDir}`, 'main.ts'], root);
        strictEqual(result.code, 0, result.stderr);
        deepStrictEqual(result.stdout.trim().split(/\r?\n/), [
            'Hello, world!',
            'true',
            'true',
            'true',
            'bar',
            'true',
        ]);
    });
});

Deno.test({ name: 'cli stage upstream npm: package origins resolve mixed-case and raw subpath imports', timeout: 20000 }, async () => {
    await withTempDir('cli-npm-package-origin-imports', async (root) => {
        const cacheDir = join(root, 'cache');
        await writeCachedNpmPackage(cacheDir, '@denotest/CAPITALS', '1.0.0', {}, {
            'index.js': 'module.exports = 5;\n',
        });
        await writeCachedNpmPackage(cacheDir, '@denotest/MixedCase', '1.0.0', {
            dependencies: { '@denotest/CAPITALS': '1.0.0' },
        }, {
            'index.js': 'module.exports = require("@denotest/CAPITALS");\n',
        });
        await writeCachedNpmMeta(cacheDir, '@denotest/MixedCase', {
            '1.0.0': {
                version: '1.0.0',
                dist: { tarball: 'https://example.invalid/MixedCase-1.0.0.tgz' },
            },
        }, { latest: '1.0.0' });

        const packageDir = join(root, 'node_modules', 'package');
        await Deno.mkdir(packageDir, { recursive: true });
        await Deno.writeTextFile(join(packageDir, 'package.json'), JSON.stringify({
            name: 'package',
            version: '1.0.0',
            exports: {
                './style.css': './style.css',
            },
        }));
        await Deno.writeTextFile(join(packageDir, 'style.css'), 'div {\\n  border-color: green;\\n}\\n');
        await Deno.writeTextFile(join(root, 'remote.ts'), `
            import value from "npm:@denotest/MixedCase";
            console.log(value);
        `);
        await Deno.writeTextFile(join(root, 'main.ts'), `
            import "./remote.ts";
            import bytes from "package/style.css" with { type: "bytes" };
            import text from "package/style.css" with { type: "text" };
            console.log(bytes.length);
            console.log(text.includes("border-color: green"));
        `);

        const result = await runCno(['run', `--cache-dir=${cacheDir}`, 'main.ts'], root);
        strictEqual(result.code, 0, result.stderr);
        deepStrictEqual(result.stdout.trim().split(/\r?\n/), ['5', '34', 'true']);
    });
});

Deno.test({ name: 'cli stage upstream npm: bin and package subpaths resolve without explicit versions', timeout: 20000 }, async () => {
    await withTempDir('cli-npm-unversioned-bin-subpaths', async (root) => {
        const cacheDir = join(root, 'cache');
        await writeCachedNpmPackage(cacheDir, '@denotest/bin', '1.0.0', {
            type: 'module',
            bin: {
                'cli-esm': './cli.mjs',
            },
        }, {
            'cli.mjs': 'for (const arg of process.argv.slice(2)) console.log(arg);\n',
        });
        await writeCachedNpmMeta(cacheDir, '@denotest/bin', {
            '1.0.0': {
                version: '1.0.0',
                dist: { tarball: 'https://example.invalid/bin-1.0.0.tgz' },
            },
        }, { latest: '1.0.0' });
        await writeCachedNpmPackage(cacheDir, '@denotest/render-dom', '1.0.0', {
            type: 'module',
            exports: {
                '.': './index.js',
                './server': './server.js',
            },
        }, {
            'index.js': 'export const client = "client";\n',
            'server.js': 'export function renderToString(value) { return "<div>" + value + "</div>"; }\n',
        });
        await Deno.writeTextFile(join(root, 'package.json'), JSON.stringify({
            name: 'run-existing-npm-package',
            dependencies: { '@denotest/bin': '1.0.0' },
        }));
        await Deno.writeTextFile(join(root, 'main.ts'), `
            import { renderToString } from "npm:@denotest/render-dom@1.0.0/server";
            console.log(renderToString("World"));
        `);

        const bin = await runCno(['run', `--cache-dir=${cacheDir}`, 'npm:@denotest/bin/cli-esm', 'dev', '--help'], root);
        strictEqual(bin.code, 0, bin.stderr);
        deepStrictEqual(bin.stdout.trim().split(/\r?\n/), ['dev', '--help']);

        const subpath = await runCno(['run', `--cache-dir=${cacheDir}`, 'main.ts'], root);
        strictEqual(subpath.code, 0, subpath.stderr);
        strictEqual(subpath.stdout.trim(), '<div>World</div>');
    });
});

Deno.test({ name: 'cli stage upstream npm: project package names do not shadow npm dependencies', timeout: 20000 }, async () => {
    await withTempDir('cli-npm-same-name-dependency', async (root) => {
        const cacheDir = join(root, 'cache');
        await writeCachedNpmPackage(cacheDir, '@denotest/add', '1.0.0', {
            type: 'module',
        }, {
            'index.js': 'export function add(a, b) { return a + b; }\n',
        });
        await Deno.writeTextFile(join(root, 'package.json'), JSON.stringify({
            name: '@denotest/add',
            version: '1.0.0',
            dependencies: {
                '@denotest/add': '1.0.0',
            },
        }));
        await Deno.writeTextFile(join(root, 'index.ts'), `
            import { add } from "@denotest/add";
            console.log(add(1, 2));
        `);

        const result = await runCno(['run', `--cache-dir=${cacheDir}`, 'index.ts'], root);
        strictEqual(result.code, 0, result.stderr);
        strictEqual(result.stdout.trim(), '3');
    });
});

Deno.test({ name: 'cli stage upstream npm: package require can see node_modules folders added at runtime', timeout: 20000 }, async () => {
    await withTempDir('cli-npm-runtime-node-modules-folder', async (root) => {
        const cacheDir = join(root, 'cache');
        const setup = await runCno(['setup', `--cache-dir=${cacheDir}`]);
        strictEqual(setup.code, 0, setup.stderr);

        await writeCachedNpmPackage(cacheDir, '@denotest/require-added-nm-folder', '1.0.0', {}, {
            'index.js': [
                'const { createRequire } = require("node:module");',
                'exports.getValue = () => createRequire(process.cwd() + "/main.js")(".other-package").get();',
            ].join('\n'),
        });
        await Deno.writeTextFile(join(root, 'main.js'), `
            import { getValue } from "npm:@denotest/require-added-nm-folder@1.0.0";
            Deno.mkdirSync("./node_modules/.other-package", { recursive: true });
            Deno.writeTextFileSync("./node_modules/.other-package/package.json", "{}");
            Deno.writeTextFileSync("./node_modules/.other-package/index.js", "exports.get = () => 5;");
            console.log(getValue());
        `);

        const result = await runCno(['run', `--cache-dir=${cacheDir}`, 'main.js'], root);
        strictEqual(result.code, 0, result.stderr);
        strictEqual(result.stdout.trim(), '5');
    });
});

Deno.test({ name: 'cli stage upstream npm: package sources decode lossy UTF-8 without aborting', timeout: 20000 }, async () => {
    await withTempDir('cli-npm-lossy-utf8', async (root) => {
        const cacheDir = join(root, 'cache');
        const encoder = new TextEncoder();
        const esmDir = await writeCachedNpmPackage(cacheDir, '@denotest/lossy-utf8-module', '1.0.0', {
            type: 'module',
        }, {});
        await Deno.writeFile(join(esmDir, 'index.js'), new Uint8Array([
            ...encoder.encode('export default "'),
            0xff, 0xfe, 0xfd,
            ...encoder.encode('";\n'),
        ]));
        const cjsDir = await writeCachedNpmPackage(cacheDir, '@denotest/lossy-utf8-script', '1.0.0', {}, {});
        await Deno.writeFile(join(cjsDir, 'index.js'), new Uint8Array([
            ...encoder.encode('module.exports = "'),
            0xff, 0xfe, 0xfd,
            ...encoder.encode('";\n'),
        ]));
        await Deno.writeTextFile(join(root, 'main.mjs'), `
            import esm from "npm:@denotest/lossy-utf8-module@1.0.0";
            import cjs from "npm:@denotest/lossy-utf8-script@1.0.0";
            const codes = (value) => Array.from(value, (char) => char.charCodeAt(0)).join(",");
            console.log(codes(esm));
            console.log(codes(cjs));
        `);

        const result = await runCno(['run', `--cache-dir=${cacheDir}`, 'main.mjs'], root);
        strictEqual(result.code, 0, result.stderr);
        deepStrictEqual(result.stdout.trim().split(/\r?\n/), [
            '65533,65533,65533',
            '65533,65533,65533',
        ]);
    });
});

Deno.test({ name: 'cli stage upstream npm: cached-only rejects packages missing from cache', timeout: 20000 }, async () => {
    await withTempDir('cli-npm-cached-only', async (root) => {
        const cacheDir = join(root, 'cache');
        await Deno.writeTextFile(join(root, 'main.ts'), `
            import value from "npm:@denotest/not-cached@1.0.0";
            console.log(value);
        `);

        const result = await runCno(['run', `--cache-dir=${cacheDir}`, '--cached-only', 'main.ts'], root);
        strictEqual(result.code, 1);
        ok(result.stderr.includes('not-cached'), result.stderr);
        ok(result.stderr.includes('--cached-only'), result.stderr);
        ok(!result.stderr.includes('Download'), result.stderr);
    });
});

Deno.test({ name: 'cli stage upstream npm: invalid static package specifier fails before entry completes', timeout: 20000 }, async () => {
    await withTempDir('cli-npm-invalid-static-specifier', async (root) => {
        await Deno.writeTextFile(join(root, 'main.js'), `
            import * as foo from "npm:@foo";
            console.log(foo);
        `);

        const result = await runCno(['run', 'main.js'], root);
        strictEqual(result.code, 1);
        ok(result.stderr.includes('Invalid scoped package') || result.stderr.includes('Invalid package'), result.stderr);
        ok(!result.stdout.includes('[object Module]'), result.stdout);
    });
});

Deno.test({ name: 'cli stage upstream npm: invalid dynamic package specifier is catchable', timeout: 20000 }, async () => {
    await withTempDir('cli-npm-invalid-dynamic-specifier', async (root) => {
        await Deno.writeTextFile(join(root, 'main.ts'), `
            try {
                await import("npm:@foo");
                console.log("UNREACHABLE");
            } catch (err) {
                console.log("FAILED");
                console.log(err instanceof Error);
            }
            console.log("DONE");
        `);

        const result = await runCno(['run', '--reload', 'main.ts'], root);
        strictEqual(result.code, 0, result.stderr);
        deepStrictEqual(result.stdout.trim().split(/\r?\n/), ['FAILED', 'true', 'DONE']);
    });
});

Deno.test({ name: 'cli stage upstream npm: missing dynamic package version is catchable', timeout: 20000 }, async () => {
    await withTempDir('cli-npm-missing-dynamic-version', async (root) => {
        const cacheDir = join(root, 'cache');
        await writeCachedNpmMeta(cacheDir, '@denotest/esm-basic', {
            '1.0.0': {
                version: '1.0.0',
                dist: { tarball: 'https://example.invalid/esm-basic-1.0.0.tgz' },
            },
        }, { latest: '1.0.0' });
        await Deno.writeTextFile(join(root, 'main.ts'), `
            try {
                await import("npm:@denotest/esm-basic@99.99.99");
                console.log("UNREACHABLE");
            } catch (err) {
                console.log("FAILED");
                console.log(err instanceof Error);
                console.log(String(err).includes("99.99.99"));
            }
            console.log("DONE");
        `);

        const result = await runCno(['run', `--cache-dir=${cacheDir}`, 'main.ts'], root);
        strictEqual(result.code, 0, result.stderr);
        deepStrictEqual(result.stdout.trim().split(/\r?\n/), ['FAILED', 'true', 'true', 'DONE']);
    });
});

Deno.test({ name: 'cli stage upstream npm: missing package subpaths fail without fallback', timeout: 20000 }, async () => {
    await withTempDir('cli-npm-missing-subpath', async (root) => {
        const cacheDir = join(root, 'cache');
        await writeCachedNpmPackage(cacheDir, '@denotest/subpath', '1.0.0', {
            type: 'module',
        }, {
            'index.js': 'export const ok = true;\n',
        });
        await Deno.writeTextFile(join(root, 'cached.ts'), `
            import value from "npm:@denotest/subpath@1.0.0/non-existent";
            console.log(value);
        `);

        const cached = await runCno(['run', `--cache-dir=${cacheDir}`, 'cached.ts'], root);
        strictEqual(cached.code, 1);
        ok(cached.stderr.includes('non-existent') || cached.stderr.includes('Cannot resolve'), cached.stderr);

        const pkgDir = join(root, 'node_modules', '@denotest', 'subpath');
        await Deno.mkdir(pkgDir, { recursive: true });
        await Deno.writeTextFile(join(pkgDir, 'package.json'), JSON.stringify({
            name: '@denotest/subpath',
            version: '1.0.0',
            type: 'module',
            main: './index.js',
        }));
        await Deno.writeTextFile(join(pkgDir, 'index.js'), 'export const ok = true;\n');
        await Deno.writeTextFile(join(root, 'node_modules_entry.ts'), `
            import value from "npm:@denotest/subpath@1.0.0/non-existent";
            console.log(value);
        `);

        const local = await runCno(['run', `--cache-dir=${cacheDir}`, 'node_modules_entry.ts'], root);
        strictEqual(local.code, 1);
        ok(local.stderr.includes('non-existent') || local.stderr.includes('Cannot resolve'), local.stderr);
    });
});

Deno.test({ name: 'cli stage upstream npm: workers can import npm while another worker closes', timeout: 20000 }, async () => {
    await withTempDir('cli-npm-worker-shutdown-import', async (root) => {
        const cacheDir = join(root, 'cache');
        await writeCachedNpmPackage(cacheDir, '@denotest/add', '1.0.0', {
            type: 'module',
        }, {
            'index.js': 'export function add(a, b) { return a + b; }\n',
        });
        await writeCachedNpmPackage(cacheDir, '@denotest/subtract', '1.0.0', {
            type: 'module',
        }, {
            'index.js': 'export function subtract(a, b) { return a - b; }\n',
        });
        await Deno.writeTextFile(join(root, 'worker1.ts'), `
            const [{ add }, { subtract }] = await Promise.all([
                import("npm:@denotest/add@1.0.0"),
                import("npm:@denotest/subtract@1.0.0"),
            ]);
            self.postMessage("loaded:" + add(1, 2) + ":" + subtract(5, 3));
            self.close();
        `);
        await Deno.writeTextFile(join(root, 'worker2.ts'), `
            [
                "npm:@denotest/add@1.0.0",
                "npm:@denotest/subtract@1.0.0",
            ].map((specifier) => import(specifier));
            await new Promise((resolve) => setTimeout(resolve, 10));
            self.postMessage("closing");
            self.close();
            self.postMessage("after-close");
            console.log("WILL NOT BE PRINTED");
        `);
        await Deno.writeTextFile(join(root, 'main.ts'), `
            const messages = [];
            function waitForMessage(worker) {
                return new Promise((resolve, reject) => {
                    worker.onmessage = (event) => {
                        messages.push(event.data);
                        resolve(event.data);
                    };
                    worker.onerror = (event) => reject(event.error ?? new Error(event.message));
                });
            }
            const worker1 = new Worker(new URL("./worker1.ts", import.meta.url), { type: "module" });
            const worker2 = new Worker(new URL("./worker2.ts", import.meta.url), { type: "module" });
            await Promise.race([
                Promise.all([waitForMessage(worker1), waitForMessage(worker2)]),
                new Promise((_, reject) => setTimeout(
                    () => reject(new Error("worker messages timed out: " + JSON.stringify(messages))),
                    1000,
                )),
            ]);
            await new Promise((resolve) => setTimeout(resolve, 50));
            if (messages.includes("after-close")) throw new Error("worker ran after self.close()");
            console.log(messages.sort().join("|"));
        `);

        const result = await runCno(['run', `--cache-dir=${cacheDir}`, 'main.ts'], root);
        strictEqual(result.code, 0, result.stderr);
        strictEqual(result.stdout.trim(), 'closing|loaded:3:2');
    });
});

Deno.test({ name: 'cli stage upstream npm: package json import attributes read npm package metadata', timeout: 20000 }, async () => {
    await withTempDir('cli-npm-json-import-attribute', async (root) => {
        const cacheDir = join(root, 'cache');
        await writeCachedNpmPackage(cacheDir, '@denotest/binary-package', '1.0.0', {
            main: 'index.js',
            optionalDependencies: {
                '@denotest/binary-package-linux': '1.0.0',
                '@denotest/binary-package-mac': '1.0.0',
                '@denotest/binary-package-windows': '1.0.0',
            },
        }, {
            'index.js': 'module.exports = 1;\n',
        });
        await Deno.writeTextFile(join(root, 'main.js'), `
            import json from "npm:@denotest/binary-package@1.0.0/package.json" with { type: "json" };
            console.log(json.name);
            console.log(json.optionalDependencies["@denotest/binary-package-linux"]);
        `);

        const result = await runCno(['run', `--cache-dir=${cacheDir}`, 'main.js'], root);
        strictEqual(result.code, 0, result.stderr);
        deepStrictEqual(result.stdout.trim().split(/\r?\n/), ['@denotest/binary-package', '1.0.0']);
    });
});

Deno.test({ name: 'cli stage upstream npm: local node_modules imports share package module identity', timeout: 20000 }, async () => {
    await withTempDir('cli-npm-node-modules-identity', async (root) => {
        const pkgDir = join(root, 'node_modules', '@denotest', 'esm-basic');
        await Deno.mkdir(pkgDir, { recursive: true });
        await Deno.writeTextFile(join(pkgDir, 'package.json'), JSON.stringify({
            name: '@denotest/esm-basic',
            version: '1.0.0',
            type: 'module',
            main: './main.mjs',
        }));
        await Deno.writeTextFile(join(pkgDir, 'main.mjs'), `
            let value = 0;
            export function setValue(newValue) { value = newValue; }
            export function getValue() { return value; }
        `);
        await Deno.writeTextFile(join(root, 'main.ts'), `
            import * as myImport1 from "@denotest/esm-basic";
            import * as myImport2 from "./node_modules/@denotest/esm-basic/main.mjs";
            import * as myImport3 from "@denotest/esm-basic/main.mjs";
            myImport1.setValue(5);
            myImport2.setValue(2);
            console.log(myImport1.getValue());
            console.log(myImport2.getValue());
            console.log(myImport3.getValue());
        `);

        const result = await runCno(['run', 'main.ts'], root);
        strictEqual(result.code, 0, result.stderr);
        deepStrictEqual(result.stdout.trim().split(/\r?\n/), ['2', '2', '2']);
    });
});

Deno.test({ name: 'cli stage upstream npm: npm specifier can match local node_modules semver range', timeout: 20000 }, async () => {
    await withTempDir('cli-npm-by-nm-range', async (root) => {
        const pkgDir = join(root, 'node_modules', 'package');
        await Deno.mkdir(pkgDir, { recursive: true });
        await Deno.writeTextFile(join(pkgDir, 'package.json'), JSON.stringify({
            name: 'package',
            version: '1.0.0',
            main: './index.js',
        }));
        await Deno.writeTextFile(join(pkgDir, 'index.js'), 'exports.add = (a, b) => a + b;\n');
        await Deno.writeTextFile(join(root, 'main.ts'), `
            import { add } from "npm:package@1";
            console.log(add(2, 3));
        `);

        const result = await runCno(['run', 'main.ts'], root);
        strictEqual(result.code, 0, result.stderr);
        strictEqual(result.stdout.trim(), '5');
    });
});

Deno.test({ name: 'cli stage: repl .q exits through cleanup and writes history', timeout: 10000 }, async () => {
    await withTempDir('cli-repl-history', async (root) => {
        const execPath = Deno.execPath().replace(/ \(deleted\)$/, '');
        const child = new Deno.Command(execPath, {
            args: ['repl'],
            cwd: root,
            stdin: 'piped',
            stdout: 'piped',
            stderr: 'piped',
            env: {
                CTS_SILENT: 'true',
                HOME: root,
            },
        }).spawn();

        const writer = child.stdin.getWriter();
        await writer.write(new TextEncoder().encode('1 + 1\n.q\n'));
        await writer.close();

        const output = await child.output();
        strictEqual(output.code, 0, decodeUtf8(output.stderr));

        const history = await Deno.readTextFile(join(root, '.cno_history'));
        ok(history.includes('1 + 1'), history);
    });
});
