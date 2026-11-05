import { deepStrictEqual, ok, strictEqual } from 'node:assert';
import { join } from 'node:path';
import { decodeUtf8 } from '../_helpers/bytes.ts';
import { writeCachedNpmMeta, writeCachedNpmPackage } from '../_helpers/npm-fixture.ts';
import { withTempDir } from '../_helpers/temp.ts';
import { runCno, runCnoWithInput } from '../_helpers/cli-stage-run.ts';

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

Deno.test({ name: 'cli stage: exec without a command prints usage instead of resolving the repl sentinel', timeout: 10000 }, async () => {
    await withTempDir('cli-exec-missing-command', async (root) => {
        const result = await runCno(['exec'], root);
        strictEqual(result.code, 1, result.stderr);
        ok(result.stderr.includes('Usage: cno exec <command> [args…]'), result.stderr);
        ok(!result.stderr.includes('Could not be resolved'), result.stderr);
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

/**
 * Env that redirects the REPL's history DB into a temp dir.
 *
 * `HOME` alone is not enough: src/commands/repl/index.ts:24 picks
 * `USERPROFILE` on Windows, so a HOME-only env let these tests write to the
 * developer's real ~/.cno_history.sqlite and then fail reading the temp path
 * with "unable to open database file".
 */
function replHistoryEnv(root: string): Record<string, string> {
    return { CTS_SILENT: 'true', HOME: root, USERPROFILE: root };
}

/** Read lines from the REPL SQLite history DB (oldest → newest). */
function readReplHistoryDb(home: string): string[] {
    const sqlite3 = import.meta.use('sqlite3');
    const path = join(home, '.cno_history.sqlite');
    const db = sqlite3.open(path, sqlite3.O_READONLY);
    try {
        const rows = db.prepare('SELECT line FROM history ORDER BY id ASC').all();
        return rows
            .map((r: { line?: unknown }) => r.line)
            .filter((l: unknown): l is string => typeof l === 'string' && l.length > 0);
    } finally {
        try { db.close(); } catch { /* */ }
    }
}
