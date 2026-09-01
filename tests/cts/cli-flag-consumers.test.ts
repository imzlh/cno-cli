// Regression tests for flags that were parsed and advertised but had no
// consumer. See applyMaxOldSpaceSize / flagsToConfig for the measurements.
import { deepStrictEqual, ok, strictEqual, throws } from 'node:assert';
import { parseArgv, unknownFlags } from '../../src/cli.ts';
import { buildCacheConfig } from '../../src/commands/cache-utils.ts';
import { decodeWorkerRuntimeConfig } from '../../src/commands/config-flags.ts';
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

Deno.test('max-old-space-size: invalid values fail early', () => {
    withoutCtsMemoryLimit(() => {
        for (const value of ['abc', '0', '-8']) {
            const cfg: Partial<ConfigOptions> = {};
            throws(
                () => applyMaxOldSpaceSize(cfg, { 'max-old-space-size': value }),
                /max-old-space-size must be a positive number/,
                `value ${JSON.stringify(value)}`,
            );
        }
        // Missing values are rejected by the CLI before this mapping runs.
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

Deno.test('worker runtime config: decodes only the bootstrap schema', () => {
    const cfg = decodeWorkerRuntimeConfig({
        cacheDir: '/cache',
        enableHttp: false,
        memoryLimit: 64 * MB,
        maxStackSize: 512 * 1024,
        conditions: ['node', 'import'],
        importMap: { '@ok': '/map.ts', invalid: false },
        importMapScopes: {
            'file:///scope/': { '@ok': '/scope.ts', invalid: 1 },
            invalid: 'not-a-map',
        },
        pathAliases: { '@/*': ['src/*'], invalid: ['src/*', false] },
        ignored: true,
    });

    deepStrictEqual(cfg, {
        cacheDir: '/cache',
        enableHttp: false,
        memoryLimit: 64 * MB,
        maxStackSize: 512 * 1024,
        conditions: ['node', 'import'],
        importMap: { '@ok': '/map.ts' },
        importMapScopes: { 'file:///scope/': { '@ok': '/scope.ts' } },
        pathAliases: { '@/*': ['src/*'] },
    });
    strictEqual(decodeWorkerRuntimeConfig({
        enableHttp: 'false',
        memoryLimit: -1,
        maxStackSize: Infinity,
        conditions: ['node', 1],
    }), undefined);
    strictEqual(decodeWorkerRuntimeConfig({
        importMap: ['/map.ts'],
        importMapScopes: [['/scope.ts']],
        pathAliases: [['src/*']],
    }), undefined);
});

Deno.test('cache config: resolution and resource flags are preserved', () => {
    withoutCtsMemoryLimit(() => {
        const cfg = buildCacheConfig({}, {
            'frozen': true,
            'no-http': true,
            'no-jsr': true,
            'no-node': true,
            'disable-cache': true,
            'cached-only': true,
            'memory-limit': '32MB',
            'max-old-space-size': '64',
        });
        strictEqual(cfg.frozen, true);
        strictEqual(cfg.enableHttp, false);
        strictEqual(cfg.enableJsr, false);
        strictEqual(cfg.enableNode, false);
        strictEqual(cfg.enableCache, false);
        strictEqual(cfg.cachedOnly, true);
        strictEqual(cfg.memoryLimit, 32 * MB);
        strictEqual(cfg.disableLock, false);
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

// Flags valid only for another subcommand must be rejected before dispatch.
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
    deepStrictEqual(unknownFlags(parseArgv(['cache', '--no-lock', 'main.ts'])), ['--no-lock']);
    deepStrictEqual(unknownFlags(parseArgv(['eval', '--env=.env', '1+1'])), ['--env']);

    // Sanity: each flag IS valid for its own command, so the scoping must not
    // over-reject. These pass today and must keep passing.
    deepStrictEqual(unknownFlags(parseArgv(['test', '--filter=t', '--fail-fast'])), []);
    deepStrictEqual(unknownFlags(parseArgv(['pack', 'main.ts', '--out=o.jspack'])), []);
    deepStrictEqual(unknownFlags(parseArgv(['task', 'build', '--cwd=/tmp'])), []);
    deepStrictEqual(unknownFlags(parseArgv(['cache', '--frozen', '--no-http', 'main.ts'])), []);
});
