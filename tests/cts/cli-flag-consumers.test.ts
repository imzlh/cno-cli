// Regression tests for flags that were parsed and advertised but had no
// consumer. See applyMaxOldSpaceSize / flagsToConfig for the measurements.
import { deepStrictEqual, ok, strictEqual } from 'node:assert';
import { parseArgv, unknownFlags } from '../../src/cli.ts';
import { applyMaxOldSpaceSize } from '../../src/commands/flags-config.ts';
import { flagsToConfig } from '../../src/commands/run.ts';
import type { ConfigOptions } from '../../cts/src/types.ts';

// applyMaxOldSpaceSize defers to CTS_MEMORY_LIMIT, so the tests must control it.
function withoutCtsMemoryLimit<T>(fn: () => T): T {
    const previous = Deno.env.get('CTS_MEMORY_LIMIT');
    if (previous !== undefined) Deno.env.delete('CTS_MEMORY_LIMIT');
    try {
        return fn();
    } finally {
        if (previous !== undefined) Deno.env.set('CTS_MEMORY_LIMIT', previous);
    }
}

const MB = 1024 * 1024;

Deno.test('max-old-space-size: CLI flag becomes a real memory cap', () => {
    withoutCtsMemoryLimit(() => {
        const cfg: Partial<ConfigOptions> = {};
        applyMaxOldSpaceSize(cfg, { 'max-old-space-size': '64' });
        strictEqual(cfg.memoryLimit, 64 * MB);
    });
});

Deno.test('max-old-space-size: inherited from NODE_OPTIONS via execArgv', () => {
    withoutCtsMemoryLimit(() => {
        // The usual way CI/containers cap a build. NODE_OPTIONS never reaches
        // `flags`, only execArgv, so this path needs its own coverage.
        const eq: Partial<ConfigOptions> = {};
        applyMaxOldSpaceSize(eq, {}, ['--max-old-space-size=32']);
        strictEqual(eq.memoryLimit, 32 * MB);

        const spaced: Partial<ConfigOptions> = {};
        applyMaxOldSpaceSize(spaced, {}, ['--max-old-space-size', '48']);
        strictEqual(spaced.memoryLimit, 48 * MB);
    });
});

Deno.test('max-old-space-size: cno-native limits win', () => {
    withoutCtsMemoryLimit(() => {
        // An explicit --memory-limit already produced a limit; do not widen it.
        const cfg: Partial<ConfigOptions> = { memoryLimit: 16 * MB };
        applyMaxOldSpaceSize(cfg, { 'max-old-space-size': '4096' });
        strictEqual(cfg.memoryLimit, 16 * MB);
    });

    const previous = Deno.env.get('CTS_MEMORY_LIMIT');
    Deno.env.set('CTS_MEMORY_LIMIT', '64MB');
    try {
        const cfg: Partial<ConfigOptions> = {};
        applyMaxOldSpaceSize(cfg, { 'max-old-space-size': '4096' });
        strictEqual(cfg.memoryLimit, undefined);
    } finally {
        if (previous === undefined) Deno.env.delete('CTS_MEMORY_LIMIT');
        else Deno.env.set('CTS_MEMORY_LIMIT', previous);
    }
});

Deno.test('max-old-space-size: garbage is ignored, not fatal', () => {
    withoutCtsMemoryLimit(() => {
        for (const value of ['abc', '0', '-8', '']) {
            const cfg: Partial<ConfigOptions> = {};
            applyMaxOldSpaceSize(cfg, { 'max-old-space-size': value });
            strictEqual(cfg.memoryLimit, undefined, `value ${JSON.stringify(value)}`);
        }
        // Bare boolean form (no value supplied) must not become NaN.
        const bare: Partial<ConfigOptions> = {};
        applyMaxOldSpaceSize(bare, { 'max-old-space-size': true });
        strictEqual(bare.memoryLimit, undefined);
    });
});

Deno.test('max-old-space-size: honored via deno-style --v8-flags', () => {
    withoutCtsMemoryLimit(() => {
        const single: Partial<ConfigOptions> = {};
        applyMaxOldSpaceSize(single, { 'v8-flags': '--max-old-space-size=32' });
        strictEqual(single.memoryLimit, 32 * MB);

        const csv: Partial<ConfigOptions> = {};
        applyMaxOldSpaceSize(csv, { 'v8-flags': '--jitless,--max-old-space-size=24' });
        strictEqual(csv.memoryLimit, 24 * MB);

        // An unrelated v8 flag must not invent a limit.
        const other: Partial<ConfigOptions> = {};
        applyMaxOldSpaceSize(other, { 'v8-flags': '--jitless' });
        strictEqual(other.memoryLimit, undefined);
    });
});

Deno.test('flagsToConfig: isolation flags reach the config', () => {
    withoutCtsMemoryLimit(() => {
        // These are the flags that decide whether a protocol handler is
        // registered at all (cts/src/resolve/index.ts:239). A dropped flag here
        // silently restores network/node access.
        const cfg = flagsToConfig({
            'no-http': true,
            'no-jsr': true,
            'no-node': true,
            'no-oxc': true,
            'cached-only': true,
            'disable-cache': true,
            'frozen': true,
            'no-lock': true,
            'memory-limit': '64MB',
        });
        strictEqual(cfg.enableHttp, false);
        strictEqual(cfg.enableJsr, false);
        strictEqual(cfg.enableNode, false);
        strictEqual(cfg.enableOxc, false);
        strictEqual(cfg.cachedOnly, true);
        strictEqual(cfg.enableCache, false);
        strictEqual(cfg.frozen, true);
        strictEqual(cfg.disableLock, true);
        strictEqual(cfg.memoryLimit, 64 * MB);
    });
});

Deno.test('flagsToConfig: absent flags stay undefined so file config still applies', () => {
    withoutCtsMemoryLimit(() => {
        const cfg = flagsToConfig({});
        strictEqual(cfg.enableHttp, undefined);
        strictEqual(cfg.enableNode, undefined);
        strictEqual(cfg.memoryLimit, undefined);
        strictEqual(cfg.cacheDir, undefined);
    });
});

Deno.test('cli: --loader is parsed as a node runtime value flag', () => {
    // Parsing is correct; the gap is downstream — runNodePreloads in
    // src/commands/run.ts handles kind 'require' and 'import' but drops
    // 'loader', so the hook module is never evaluated. OBSERVED: a resolve()
    // hook passed via --loader never printed. Locking in the parse shape so a
    // future consumer has a defined input.
    const cli = parseArgv(['--loader=./hook.mjs', 'main.ts']);
    strictEqual(cli.flags.loader, './hook.mjs');
    deepStrictEqual(cli.rawArgs.internalArgs, ['--loader=./hook.mjs']);
    strictEqual(cli.rawArgs.entry, 'main.ts');

    const spaced = parseArgv(['--loader', './hook.mjs', 'main.ts']);
    strictEqual(spaced.flags.loader, './hook.mjs');
});

Deno.test('cli: --cwd requires a value and is task-scoped', () => {
    // Only src/commands/task.ts reads --cwd; on run/eval/test it parses and is
    // then ignored (OBSERVED: `cno --cwd=/tmp argv.js` reported the original
    // cwd). It is also absent from --help. Asserting the value-flag contract so
    // the bare form still errors rather than silently becoming `true`.
    const cli = parseArgv(['--cwd=/tmp', 'main.ts']);
    strictEqual(cli.flags.cwd, '/tmp');

    const spaced = parseArgv(['--cwd', '/tmp', 'main.ts']);
    strictEqual(spaced.flags.cwd, '/tmp');
    strictEqual(spaced.rawArgs.entry, 'main.ts');
});

Deno.test('cli: max-old-space-size accepts both = and space forms', () => {
    const eq = parseArgv(['--max-old-space-size=64', 'main.ts']);
    strictEqual(eq.flags['max-old-space-size'], '64');
    ok(eq.rawArgs.internalArgs.includes('--max-old-space-size=64'));

    const spaced = parseArgv(['--max-old-space-size', '64', 'main.ts']);
    strictEqual(spaced.flags['max-old-space-size'], '64');
    strictEqual(spaced.rawArgs.entry, 'main.ts');
});

// ---------------------------------------------------------------------------
// EXPECTED-RED. `unknownFlags` validates against one flat KNOWN_FLAGS set
// (src/cli.ts:530) with no per-subcommand scoping, so a flag that is valid for
// *some* command is accepted by *every* command and then silently dropped by a
// consumer that never reads it.
//
// OBSERVED against build/stage/cno.exe (2026-08-04 15:59):
//   cno repl --filter=xyz          -> rc 0
//   cno repl --out=x.jspack        -> rc 0
//   cno run  --out=x entry.js      -> rc 0, entry ran, flag ignored
//   cno eval --filter=x 1+1        -> rc 0
//   cno pack --filter=x entry.js   -> rc 0, packed anyway
// deno rejects the same shape (`deno run --filter=x` -> rc 1 "unexpected
// argument '--filter' found"); node exits 9 ("bad option"). A user who types
// `cno run --filter=foo` meaning `cno test` gets a clean exit 0 and no warning.
//
// This test states the contract cno should meet. It FAILS today: every
// assertion below currently gets `[]` back. Do not "fix" it by deleting the
// cases — the fix is to give unknownFlags a per-command allow-list.
// ---------------------------------------------------------------------------
Deno.test('flag scoping: a flag valid elsewhere is rejected for this command', () => {
    // test-only flags must not be silently accepted by run/repl/eval/pack.
    deepStrictEqual(unknownFlags(parseArgv(['repl', '--filter=xyz'])), ['--filter']);
    deepStrictEqual(unknownFlags(parseArgv(['repl', '--concurrency=9'])), ['--concurrency']);
    deepStrictEqual(unknownFlags(parseArgv(['repl', '--fail-fast'])), ['--fail-fast']);
    deepStrictEqual(unknownFlags(parseArgv(['repl', '--permit-no-files'])), ['--permit-no-files']);
    deepStrictEqual(unknownFlags(parseArgv(['eval', '--filter=x', '1+1'])), ['--filter']);

    // pack-only flags must not be accepted by run/repl/test.
    deepStrictEqual(unknownFlags(parseArgv(['repl', '--out=x.jspack'])), ['--out']);
    deepStrictEqual(unknownFlags(parseArgv(['run', '--out=x', 'main.ts'])), ['--out']);

    // task-only --cwd must not be accepted by test (help.ts calls it
    // "task only; ignored elsewhere" — so "ignored" should mean "rejected").
    deepStrictEqual(unknownFlags(parseArgv(['test', '--cwd=/tmp'])), ['--cwd']);

    // Sanity: each flag IS valid for its own command, so the scoping must not
    // over-reject. These pass today and must keep passing.
    deepStrictEqual(unknownFlags(parseArgv(['test', '--filter=t', '--fail-fast'])), []);
    deepStrictEqual(unknownFlags(parseArgv(['pack', 'main.ts', '--out=o.jspack'])), []);
    deepStrictEqual(unknownFlags(parseArgv(['task', 'build', '--cwd=/tmp'])), []);
});
