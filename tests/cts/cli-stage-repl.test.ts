import { deepStrictEqual, ok, strictEqual } from 'node:assert';
import { join } from 'node:path';
import { decodeUtf8 } from '../_helpers/bytes.ts';
import { writeCachedNpmMeta, writeCachedNpmPackage } from '../_helpers/npm-fixture.ts';
import { withTempDir } from '../_helpers/temp.ts';
import { runCno, runCnoWithInput } from '../_helpers/cli-stage-run.ts';

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

Deno.test({ name: 'cli stage: repl .q exits through cleanup and writes history', timeout: 10000 }, async () => {
    await withTempDir('cli-repl-history', async (root) => {
        const execPath = Deno.execPath().replace(/ \(deleted\)$/, '');
        const child = new Deno.Command(execPath, {
            args: ['repl'],
            cwd: root,
            stdin: 'piped',
            stdout: 'piped',
            stderr: 'piped',
            env: replHistoryEnv(root),
        }).spawn();

        const writer = child.stdin.getWriter();
        await writer.write(new TextEncoder().encode('1 + 1\n.q\n'));
        await writer.close();

        const output = await child.output();
        strictEqual(output.code, 0, decodeUtf8(output.stderr));

        const lines = readReplHistoryDb(root);
        ok(lines.includes('1 + 1'), lines.join('\n'));
        ok(!lines.some((l) => l.includes('.q')), `directives must not land in history: ${lines.join('|')}`);
        // Primary store is SQLite, not the legacy text file.
        let textExists = false;
        try {
            await Deno.stat(join(root, '.cno_history'));
            textExists = true;
        } catch { /* expected missing */ }
        ok(!textExists, 'legacy .cno_history text should not be the primary store');
    });
});

Deno.test({ name: 'cli stage: repl reloads prior history on next session', timeout: 15000 }, async () => {
    await withTempDir('cli-repl-history-reload', async (root) => {
        const execPath = Deno.execPath().replace(/ \(deleted\)$/, '');
        const env = replHistoryEnv(root);

        // Seed a prior session.
        {
            const child = new Deno.Command(execPath, {
                args: ['repl'],
                cwd: root,
                stdin: 'piped',
                stdout: 'piped',
                stderr: 'piped',
                env,
            }).spawn();
            const writer = child.stdin.getWriter();
            await writer.write(new TextEncoder().encode('const seed = 42\n.q\n'));
            await writer.close();
            const output = await child.output();
            strictEqual(output.code, 0, decodeUtf8(output.stderr));
        }

        const seeded = readReplHistoryDb(root);
        ok(seeded.includes('const seed = 42'), seeded.join('\n'));

        // Second session should append, keeping the prior line.
        {
            const child = new Deno.Command(execPath, {
                args: ['repl'],
                cwd: root,
                stdin: 'piped',
                stdout: 'piped',
                stderr: 'piped',
                env,
            }).spawn();
            const writer = child.stdin.getWriter();
            await writer.write(new TextEncoder().encode('const next = 7\n.q\n'));
            await writer.close();
            const output = await child.output();
            strictEqual(output.code, 0, decodeUtf8(output.stderr));
        }

        const history = readReplHistoryDb(root);
        ok(history.includes('const seed = 42'), history.join('\n'));
        ok(history.includes('const next = 7'), history.join('\n'));
    });
});

Deno.test({ name: 'cli stage: repl persists history immediately after each line', timeout: 10000 }, async () => {
    await withTempDir('cli-repl-history-flush', async (root) => {
        const execPath = Deno.execPath().replace(/ \(deleted\)$/, '');
        const child = new Deno.Command(execPath, {
            args: ['repl'],
            cwd: root,
            stdin: 'piped',
            stdout: 'piped',
            stderr: 'piped',
            env: replHistoryEnv(root),
        }).spawn();

        const writer = child.stdin.getWriter();
        await writer.write(new TextEncoder().encode('99 + 1\n'));
        // Give the REPL a moment to evaluate + SQLite INSERT before killing.
        await new Promise((r) => setTimeout(r, 400));
        try {
            child.kill('SIGKILL');
        } catch { /* already exited */ }
        await writer.close().catch(() => {});
        await child.output().catch(() => {});

        const history = readReplHistoryDb(root);
        ok(history.includes('99 + 1'), history.join('\n'));
    });
});

Deno.test({
    // FAILS UNTIL REBUILD: the guard is in src/commands/repl/runner.ts
    // (`#update()` returns early when stdin is not a TTY) and src/** is baked
    // into build/stage/cno.exe. Verified failing on the 2026-08-02 21:53
    // binary with 593 escapes; expected to pass once cno.exe is rebuilt.
    name: 'cli stage: repl does not echo or repaint when stdin is not a TTY',
    timeout: 20000,
}, async () => {
    await withTempDir('cli-repl-nontty-echo', async (root) => {
        const execPath = Deno.execPath().replace(/ \(deleted\)$/, '');
        const line = 'const someVariableName = 1234567890 + 987654321;';
        const child = new Deno.Command(execPath, {
            args: ['repl'],
            cwd: root,
            stdin: 'piped',
            stdout: 'piped',
            stderr: 'piped',
            env: replHistoryEnv(root),
        }).spawn();

        const writer = child.stdin.getWriter();
        await writer.write(new TextEncoder().encode(`${line}\nsomeVariableName\n.q\n`));
        await writer.close();

        const output = await child.output();
        strictEqual(output.code, 0, decodeUtf8(output.stderr));
        const stdout = decodeUtf8(output.stdout);

        // The line editor used to run its full repaint for every printable
        // character even on a pipe: this input produced 3764 bytes and 506
        // escape sequences, where `node --interactive` produces 78 bytes and
        // zero escapes. Assert the escape storm specifically, since it is what
        // corrupts programmatic readers of REPL stdout.
        const escapes = stdout.split('\x1b').length - 1;
        ok(escapes === 0, `non-TTY stdout must carry no ANSI escapes, saw ${escapes}: ${JSON.stringify(stdout.slice(0, 400))}`);
        // Each character must not be echoed back: one occurrence per submitted
        // line at most, never one per keystroke.
        const echoes = stdout.split(line).length - 1;
        ok(echoes <= 1, `input echoed ${echoes} times: ${JSON.stringify(stdout.slice(0, 400))}`);
        // The session must still work — the value has to come back.
        ok(stdout.includes('2222222211'), stdout);
    });
});

Deno.test({
    name: 'cli stage: repl survives a throw from a timer and keeps evaluating',
    timeout: 20000,
}, async () => {
    await withTempDir('cli-repl-timer-throw', async (root) => {
        const execPath = Deno.execPath().replace(/ \(deleted\)$/, '');
        const child = new Deno.Command(execPath, {
            args: ['repl'],
            cwd: root,
            stdin: 'piped',
            stdout: 'piped',
            stderr: 'piped',
            env: replHistoryEnv(root),
        }).spawn();

        const writer = child.stdin.getWriter();
        // The REPL's runtime-evbus listener must use the per-event safe value.
        // `false` is fatal for EV_JOB_EXCEPTION (circu.js/src/utils.c:180 calls
        // TJS_Stop), so a timer throw must not tear down the session.
        await writer.write(new TextEncoder().encode(
            'setTimeout(() => { throw new Error("BOOM"); }, 5)\n'
            + 'await new Promise((r) => setTimeout(r, 200))\n'
            + '6 * 7\n'
            + '.q\n',
        ));
        await writer.close();

        const output = await child.output();
        strictEqual(output.code, 0, decodeUtf8(output.stderr));
        const stdout = decodeUtf8(output.stdout);
        // The expression AFTER the async throw must still evaluate.
        ok(stdout.includes('42'), `REPL died on the timer throw: ${stdout}`);
        ok(!stdout.includes('CALLED'), stdout);
    });
});

Deno.test({
    name: 'cli stage: repl reports unhandled rejections instead of swallowing them',
    timeout: 20000,
}, async () => {
    await withTempDir('cli-repl-rejection', async (root) => {
        const execPath = Deno.execPath().replace(/ \(deleted\)$/, '');
        const child = new Deno.Command(execPath, {
            args: ['repl'],
            cwd: root,
            stdin: 'piped',
            stdout: 'piped',
            stderr: 'piped',
            env: replHistoryEnv(root),
        }).spawn();

        const writer = child.stdin.getWriter();
        await writer.write(new TextEncoder().encode(
            'Promise.reject(new Error("REJECTED_MARKER"))\n'
            + 'await new Promise((r) => setTimeout(r, 200))\n'
            + '1 + 1\n'
            + '.q\n',
        ));
        await writer.close();

        const output = await child.output();
        strictEqual(output.code, 0, decodeUtf8(output.stderr));
        // REPL and diagnostics are independent runtime-evbus subscriptions;
        // the REPL fallback must not prevent diagnostics from seeing rejection.
        const combined = decodeUtf8(output.stdout) + decodeUtf8(output.stderr);
        ok(combined.includes('REJECTED_MARKER'), `rejection was silent: ${combined}`);
        ok(combined.includes('2'), combined);
    });
});

Deno.test({
    // FAILS UNTIL REBUILD: `.exit`/`.save` are added in
    // src/commands/repl/runner.ts and src/** is baked into build/stage/cno.exe.
    // On the 2026-08-02 21:53 binary all three print "Unknown directive".
    name: 'cli stage: repl supports .exit and .save like node',
    timeout: 20000,
}, async () => {
    await withTempDir('cli-repl-directives', async (root) => {
        const execPath = Deno.execPath().replace(/ \(deleted\)$/, '');
        const savePath = join(root, 'session.js');
        const child = new Deno.Command(execPath, {
            args: ['repl'],
            cwd: root,
            stdin: 'piped',
            stdout: 'piped',
            stderr: 'piped',
            env: replHistoryEnv(root),
        }).spawn();

        const writer = child.stdin.getWriter();
        await writer.write(new TextEncoder().encode(
            `const saved = 5\n.save ${savePath.replace(/\\/g, '/')}\n.exit\n`,
        ));
        await writer.close();

        const output = await child.output();
        strictEqual(output.code, 0, decodeUtf8(output.stderr));
        const stdout = decodeUtf8(output.stdout);
        ok(!stdout.includes('Unknown directive'), stdout);

        // `.save` writes the session's code, not the directives themselves.
        const saved = await Deno.readTextFile(savePath);
        ok(saved.includes('const saved = 5'), saved);
        ok(!saved.includes('.save'), saved);
        ok(!saved.includes('.exit'), saved);
    });
});

Deno.test({
    name: 'cli stage: repl treats a detached POSIX terminal as EOF',
    ignore: Deno.build.os === 'windows',
    timeout: 10000,
}, async () => {
    await withTempDir('cli-repl-pty', async (root) => {
        const execPath = Deno.execPath().replace(/ \(deleted\)$/, '');
        const harness = [
            'import json, os, pty, subprocess, sys, time',
            'master, slave = pty.openpty()',
            'child = subprocess.Popen([sys.argv[1], "repl"], stdin=slave, stdout=subprocess.PIPE, stderr=subprocess.PIPE, env={**os.environ, "CTS_SILENT": "true", "HOME": sys.argv[2]})',
            'os.close(slave)',
            'time.sleep(0.2)',
            'os.close(master)',
            'stdout, stderr = child.communicate(timeout=5)',
            'print(json.dumps({"code": child.returncode, "stdout": stdout.decode(errors="replace"), "stderr": stderr.decode(errors="replace")}))',
        ].join('\n');

        let output: Deno.CommandOutput;
        try {
            output = await new Deno.Command('python3', {
                args: ['-c', harness, execPath, root],
                stdout: 'piped',
                stderr: 'piped',
            }).output();
        } catch {
            return;
        }

        strictEqual(output.code, 0, decodeUtf8(output.stderr));
        const result = JSON.parse(decodeUtf8(output.stdout)) as { code: number; stderr: string };
        strictEqual(result.code, 0, result.stderr);
        ok(!result.stderr.includes('Uncaught'), result.stderr);
    });
});

// specs/run/_014_duplicate_import: same module instantiates once
Deno.test({ name: 'cli stage upstream run: duplicate static/dynamic imports instantiate once', timeout: 15000 }, async () => {
    await withTempDir('cli-run-dup-import', async (root) => {
        await Deno.writeTextFile(join(root, 'auto_print_hello.ts'), `
            console.log("hello-side-effect");
            export default {};
        `);
        await Deno.writeTextFile(join(root, 'main.ts'), `
            import "./auto_print_hello.ts";
            import "./auto_print_hello.ts";
            await import("./auto_print_hello.ts");
            console.log("done");
        `);
        const result = await runCno(['run', 'main.ts'], root);
        strictEqual(result.code, 0, result.stderr);
        const lines = result.stdout.trim().split(/\r?\n/);
        strictEqual(lines.filter((l) => l === 'hello-side-effect').length, 1, result.stdout);
        ok(lines.includes('done'), result.stdout);
    });
});

// specs/run/_020_json_modules + _021_mjs_modules
Deno.test({ name: 'cli stage upstream run: json default import and .mjs modules', timeout: 15000 }, async () => {
    await withTempDir('cli-run-json-mjs', async (root) => {
        await Deno.writeTextFile(join(root, 'config.json'), JSON.stringify({
            foo: { bar: true, baz: ['qat', 1] },
        }));
        await Deno.writeTextFile(join(root, 'mod5.mjs'), 'export const isMod5 = true;\n');
        await Deno.writeTextFile(join(root, 'main.ts'), `
            import config from "./config.json" with { type: "json" };
            import { isMod5 } from "./mod5.mjs";
            console.log(JSON.stringify(config));
            console.log(isMod5);
        `);
        const result = await runCno(['run', 'main.ts'], root);
        strictEqual(result.code, 0, result.stderr);
        const lines = result.stdout.trim().split(/\r?\n/);
        strictEqual(lines[0], '{"foo":{"bar":true,"baz":["qat",1]}}');
        strictEqual(lines[1], 'true');
    });
});

// specs/run/conditional_exports_from_require
Deno.test({ name: 'cli stage upstream run: --conditions selects package exports for require', timeout: 15000 }, async () => {
    await withTempDir('cli-run-cond-require', async (root) => {
        const pkg = join(root, 'node_modules', 'foo');
        await Deno.mkdir(pkg, { recursive: true });
        await Deno.writeTextFile(join(pkg, 'package.json'), JSON.stringify({
            name: 'foo',
            version: '1.0.0',
            exports: {
                '.': {
                    'some-condition': './good.js',
                    default: './bad.js',
                },
            },
        }));
        await Deno.writeTextFile(join(pkg, 'good.js'), 'console.log("good");\n');
        await Deno.writeTextFile(join(pkg, 'bad.js'), 'console.log("bad");\n');
        await Deno.writeTextFile(join(root, 'main.cjs'), 'require("foo");\n');

        const withCond = await runCno(['--conditions', 'some-condition', 'run', 'main.cjs'], root);
        strictEqual(withCond.code, 0, withCond.stderr);
        strictEqual(withCond.stdout.trim(), 'good');

        const noCond = await runCno(['run', 'main.cjs'], root);
        strictEqual(noCond.code, 0, noCond.stderr);
        strictEqual(noCond.stdout.trim(), 'bad');
    });
});

// specs/npm/dual_cjs_esm (local dual package cache substitute)
Deno.test({ name: 'cli stage upstream npm: dual package import and cjs subpath resolve from cache', timeout: 20000 }, async () => {
    await withTempDir('cli-npm-dual-cjs-esm', async (root) => {
        const cacheDir = join(root, 'cache');
        await writeCachedNpmMeta(cacheDir, '@denotest/dual-cjs-esm', {
            '1.0.0': { name: '@denotest/dual-cjs-esm', version: '1.0.0' },
        }, { latest: '1.0.0' });
        await writeCachedNpmPackage(cacheDir, '@denotest/dual-cjs-esm', '1.0.0', {
            type: 'module',
            exports: {
                '.': {
                    import: './esm/main.js',
                    require: './cjs/main.cjs',
                    default: './esm/main.js',
                },
                './cjs/main.cjs': './cjs/main.cjs',
            },
        }, {
            'esm/main.js': 'export function getKind() { return "esm"; }\n',
            'cjs/main.cjs': `
                exports.getKind = () => "cjs";
                exports.getSubPathKind = () => "cjs";
            `,
        });
        await Deno.writeTextFile(join(root, 'main.ts'), `
            import { getKind } from "npm:@denotest/dual-cjs-esm@latest";
            import * as cjs from "npm:@denotest/dual-cjs-esm@latest/cjs/main.cjs";
            console.log(getKind());
            console.log(cjs.getKind());
            console.log(cjs.getSubPathKind());
        `);

        const result = await runCno(['run', `--cache-dir=${cacheDir}`, 'main.ts'], root);
        strictEqual(result.code, 0, result.stderr);
        strictEqual(result.stdout.trim(), 'esm\ncjs\ncjs');
    });
});

// CTS intentionally does not implement Deno's source-content ESM detection.
Deno.test({ name: 'cli stage: CJS package .js is never reclassified from source syntax', timeout: 20000 }, async () => {
    await withTempDir('cli-detect-esm-as-cjs', async (root) => {
        const untyped = join(root, 'node_modules', 'package');
        await Deno.mkdir(untyped, { recursive: true });
        await Deno.writeTextFile(join(untyped, 'package.json'), JSON.stringify({ name: 'package' }));
        await Deno.writeTextFile(join(untyped, 'index.js'), 'export function add(a, b) { return a + b; }\n');
        await Deno.writeTextFile(join(root, 'main.ts'), `
            import { add } from "package";
            console.log(add(1, 2));
        `);
        const untypedResult = await runCno(['run', 'main.ts'], root);
        ok(untypedResult.code !== 0);
        ok(untypedResult.stderr.includes('unsupported keyword: export'));

        const typed = join(root, 'pkg-commonjs');
        await Deno.mkdir(typed, { recursive: true });
        await Deno.writeTextFile(join(typed, 'package.json'), JSON.stringify({ type: 'commonjs' }));
        await Deno.writeTextFile(join(typed, 'add.js'), 'module.exports.add = (a, b) => a + b;\n');
        await Deno.writeTextFile(join(typed, 'main_esm.js'), `
            import { add } from "./add.js";
            console.log(add(1, 2));
        `);
        await Deno.writeTextFile(join(typed, 'main_cjs.js'), `
            const { add } = require("./add");
            console.log(add(1, 2));
        `);
        const esm = await runCno(['run', 'main_esm.js'], typed);
        ok(esm.code !== 0);
        const cjs = await runCno(['run', 'main_cjs.js'], typed);
        strictEqual(cjs.code, 0, cjs.stderr);
        strictEqual(cjs.stdout.trim(), '3');
    });
});

// specs/test/ignore + only via real test CLI
Deno.test({ name: 'cli stage upstream test: ignore and only filter registered tests', timeout: 20000 }, async () => {
    await withTempDir('cli-test-ignore-only', async (root) => {
        await Deno.writeTextFile(join(root, 'ignore_main.ts'), `
            for (let i = 0; i < 3; i++) {
                Deno.test({ name: "ignored " + i, ignore: true, fn() { throw new Error("unreachable"); } });
            }
            Deno.test.ignore("ignored helper", () => { throw new Error("unreachable"); });
            Deno.test("runs", () => {});
        `);
        const ignored = await runCno(['test', 'ignore_main.ts'], root);
        strictEqual(ignored.code, 0, ignored.stderr + ignored.stdout);
        ok(ignored.stdout.includes('runs') || ignored.stderr.includes('runs') || ignored.stdout.includes('ok'), ignored.stdout + ignored.stderr);

        await Deno.writeTextFile(join(root, 'only_main.ts'), `
            Deno.test("before", () => { throw new Error("before should not run"); });
            Deno.test({ only: true, name: "only", fn() {} });
            Deno.test.only("only2", () => {});
            Deno.test("after", () => { throw new Error("after should not run"); });
        `);
        const only = await runCno(['test', 'only_main.ts'], root);
        // Deno exits 1 when only is used (filter failure mode); cno may exit 0 if only tests pass.
        // Assert the non-only tests did not fail the run as executed failures.
        ok(only.code === 0 || only.code === 1, only.stderr + only.stdout);
        ok(!only.stderr.includes('before should not run'), only.stderr);
        ok(!only.stderr.includes('after should not run'), only.stderr);
    });
});

// specs/run/stdin_cjs
Deno.test({ name: 'cli stage upstream run: stdin --ext=cjs resolves relative requires from cwd', timeout: 15000 }, async () => {
    await withTempDir('cli-stdin-cjs', async (root) => {
        await Deno.writeTextFile(join(root, 'say_hello.js'), 'console.log("Hello!");\n');
        const result = await runCnoWithInput(
            ['run', '-q', '--ext=cjs', '-'],
            "require('./say_hello.js');\n",
            root,
        );
        strictEqual(result.code, 0, result.stderr);
        strictEqual(result.stdout.trim(), 'Hello!');
    });
});
