// Regression tests for flags that were parsed and advertised but had no
// consumer. See applyMaxOldSpaceSize / flagsToConfig for the measurements.
import { deepStrictEqual, ok, strictEqual, throws } from 'node:assert';
import { parseArgv, unknownFlags } from '../../src/cli.ts';
import { buildCacheConfig } from '../../src/commands/cache-utils.ts';
import { applyMaxOldSpaceSize, decodeWorkerRuntimeConfig, flagsToConfig, publishWorkerRuntimeConfig, WORKER_RUNTIME_CONFIG_KEYS } from '../../src/config.ts';
import { effectiveRuntimeFlags, prepareKernel } from '../../src/kernel.ts';
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

Deno.test('kernel config: NODE_OPTIONS defaults precede explicit prefix options', () => {
    withoutCtsMemoryLimit(() => {
        const previous = Deno.env.get('NODE_OPTIONS');
        try {
            for (const option of ['--max-old-space-size=32', '--max-old-space-size 32']) {
                Deno.env.set('NODE_OPTIONS', `${option} --conditions=environment`);
                const inherited = prepareKernel(parseArgv(['run', 'main.ts']));
                strictEqual(inherited.config.memoryLimit, 32 * MB);
                deepStrictEqual(inherited.config.conditions, ['environment']);

                const cli = parseArgv([
                    '--max-old-space-size=48', '--conditions=prefix',
                    'run', '--max-old-space-size=96', '--conditions=ignored', 'main.ts',
                ]);
                const explicit = prepareKernel(cli);
                strictEqual(explicit.config.memoryLimit, 48 * MB);
                deepStrictEqual(explicit.config.conditions, ['environment', 'prefix']);

                const v8 = prepareKernel(parseArgv(['--v8-flags=--max-old-space-size=24', 'run', 'main.ts']));
                strictEqual(v8.config.memoryLimit, 24 * MB);
            }
        } finally {
            if (previous === undefined) Deno.env.delete('NODE_OPTIONS');
            else Deno.env.set('NODE_OPTIONS', previous);
        }
    });
});

Deno.test('kernel config: command runtime values override prefix defaults without losing core settings', () => {
    withoutCtsMemoryLimit(() => {
        const cli = parseArgv([
            '--cache-dir=prefix-cache', '--memory-limit=64MB', '--no-http',
            'run', '--cache-dir=command-cache', '--memory-limit=128MB', 'main.ts',
        ]);
        const kernel = prepareKernel(cli, { inheritNodeOptions: false });
        const config = { ...kernel.config, ...flagsToConfig(effectiveRuntimeFlags(kernel, cli.flags)) };
        strictEqual(config.cacheDir, 'command-cache');
        strictEqual(config.memoryLimit, 64 * MB);
        strictEqual(config.enableHttp, false);
    });
});

Deno.test('kernel config: task config defaults respect explicit command values', () => {
    for (const commandArgs of [[], ['--config=command.json']]) {
        const cli = parseArgv(['--config=prefix.json', 'task', ...commandArgs, 'build']);
        const kernel = prepareKernel(cli, { inheritNodeOptions: false });
        strictEqual(effectiveRuntimeFlags(kernel, cli.flags).config,
            commandArgs.length ? 'command.json' : 'prefix.json');
    }
});

Deno.test('kernel config: explicit false disables Inspector and runtime switches', () => {
    const cli = parseArgv(['--inspect=false', '--no-http=true', 'run', '--no-http=false', 'main.ts']);
    const kernel = prepareKernel(cli, { inheritNodeOptions: false });
    strictEqual(kernel.inspect, null);
    strictEqual(cli.kernelFlags.inspect, false);
    strictEqual(cli.kernelFlags['no-http'], true);
    strictEqual(cli.flags['no-http'], false);
    strictEqual(flagsToConfig(effectiveRuntimeFlags(kernel, cli.flags)).enableHttp, true);
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

Deno.test('flagsToConfig: unsafe resource sizes fail before reaching the native runtime', () => {
    for (const flag of ['memory-limit', 'max-stack-size']) {
        throws(() => flagsToConfig({ [flag]: '999999999999999999999999TB' }), /safe integer/);
    }
});

Deno.test('worker runtime config: decodes only the bootstrap schema', () => {
    const cfg = decodeWorkerRuntimeConfig({
        cacheDir: '/cache',
        enableHttp: false,
        memoryLimit: 64 * MB,
        maxStackSize: 512 * 1024,
        silent: true,
        jsxPragma: 'h',
        jsxFragmentPragma: 'Fragment',
        requestTimeout: 2500,
        jsrCacheTTL: 60000,
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
        silent: true,
        jsxPragma: 'h',
        jsxFragmentPragma: 'Fragment',
        requestTimeout: 2500,
        jsrCacheTTL: 60000,
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

Deno.test('worker runtime config: resource caps require safe bytes while timeouts retain milliseconds', () => {
    for (const value of [0.5, Number.MAX_SAFE_INTEGER + 1, Infinity, -1]) {
        strictEqual(decodeWorkerRuntimeConfig({ memoryLimit: value, maxStackSize: value }), undefined);
    }
    deepStrictEqual(decodeWorkerRuntimeConfig({ memoryLimit: 0, maxStackSize: 0, requestTimeout: 0.5, jsrCacheTTL: 0 }),
        { memoryLimit: 0, maxStackSize: 0, requestTimeout: 0.5, jsrCacheTTL: 0 });
    strictEqual(decodeWorkerRuntimeConfig({ requestTimeout: Infinity, jsrCacheTTL: -1 }), undefined);
});

Deno.test('worker runtime config: published snapshots detach nested state and preserve all schema keys', () => {
    const slot = '__cno_worker_runtime_config';
    const hadPrevious = Object.hasOwn(globalThis, slot);
    const previous = Reflect.get(globalThis, slot);
    const config: Partial<ConfigOptions> = {
        conditions: ['parent'], importMap: { dep: '/parent.ts' },
        importMapScopes: { '/scope/': { dep: '/scoped.ts' } },
        pathAliases: { 'app/*': ['src/*'] },
    };
    try {
        publishWorkerRuntimeConfig(config);
        const published = Reflect.get(globalThis, slot) as Partial<ConfigOptions>;
        deepStrictEqual(Object.keys(published), [...WORKER_RUNTIME_CONFIG_KEYS]);
        strictEqual(published.silent, undefined);
        published.conditions!.push('worker');
        published.importMap!.dep = '/changed.ts';
        published.importMapScopes!['/scope/']!.dep = '/changed-scope.ts';
        published.pathAliases!['app/*']!.push('worker/*');
        deepStrictEqual(config, {
            conditions: ['parent'], importMap: { dep: '/parent.ts' },
            importMapScopes: { '/scope/': { dep: '/scoped.ts' } },
            pathAliases: { 'app/*': ['src/*'] },
        });
    } finally {
        if (hadPrevious) Reflect.set(globalThis, slot, previous);
        else Reflect.deleteProperty(globalThis, slot);
    }
});

Deno.test('worker runtime config: special alias names remain own properties', () => {
    const input = JSON.parse('{"importMap":{"__proto__":"/module.ts"},"importMapScopes":{"__proto__":{"__proto__":"/scoped.ts"}},"pathAliases":{"__proto__":["src/*"]}}');
    const config = decodeWorkerRuntimeConfig(input)!;
    deepStrictEqual(config, input);
    for (const value of [config.importMap, config.importMapScopes, config.importMapScopes!.__proto__, config.pathAliases]) {
        strictEqual(Object.getPrototypeOf(value), Object.prototype);
        ok(Object.hasOwn(value, '__proto__'));
    }
});

Deno.test('worker runtime config: explicit empty maps survive to override worker project defaults', () => {
    const empty = { importMap: {}, importMapScopes: {}, pathAliases: {} };
    deepStrictEqual(decodeWorkerRuntimeConfig(empty), empty);
    deepStrictEqual(decodeWorkerRuntimeConfig({ importMapScopes: { '/scope/': {} } }),
        { importMapScopes: { '/scope/': {} } });
    strictEqual(decodeWorkerRuntimeConfig({
        importMap: { invalid: false }, importMapScopes: { invalid: false }, pathAliases: { invalid: false },
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

Deno.test('cli: --loader belongs to the kernel option region', () => {
    const cli = parseArgv(['--loader=./hook.mjs', 'main.ts']);
    strictEqual(cli.kernelFlags.loader, './hook.mjs');
    strictEqual(cli.flags.loader, undefined);
    deepStrictEqual(cli.rawArgs.internalArgs, ['--loader=./hook.mjs']);
    strictEqual(cli.rawArgs.entry, 'main.ts');

    const spaced = parseArgv(['--loader', './hook.mjs', 'main.ts']);
    strictEqual(spaced.kernelFlags.loader, './hook.mjs');
});

Deno.test('cli: --cwd requires a value and is task-scoped', () => {
    const cli = parseArgv(['--cwd=/tmp', 'main.ts']);
    strictEqual(cli.kernelFlags.cwd, '/tmp');
    deepStrictEqual(unknownFlags(cli), ['--cwd']);

    const spaced = parseArgv(['task', '--cwd', '/tmp', 'build']);
    strictEqual(spaced.flags.cwd, '/tmp');
    strictEqual(spaced.rawArgs.entry, 'build');
    deepStrictEqual(unknownFlags(spaced), []);
});

Deno.test('cli: max-old-space-size accepts both = and space forms', () => {
    const eq = parseArgv(['--max-old-space-size=64', 'main.ts']);
    strictEqual(eq.kernelFlags['max-old-space-size'], '64');
    ok(eq.rawArgs.internalArgs.includes('--max-old-space-size=64'));

    const spaced = parseArgv(['--max-old-space-size', '64', 'main.ts']);
    strictEqual(spaced.kernelFlags['max-old-space-size'], '64');
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

    // Task-only --cwd must not be accepted by test.
    deepStrictEqual(unknownFlags(parseArgv(['test', '--cwd=/tmp'])), ['--cwd']);
    deepStrictEqual(unknownFlags(parseArgv(['cache', '--no-lock', 'main.ts'])), ['--no-lock']);
    deepStrictEqual(unknownFlags(parseArgv(['eval', '--env=.env', '1+1'])), ['--env']);

    // Sanity: each flag IS valid for its own command, so the scoping must not
    // over-reject. These pass today and must keep passing.
    deepStrictEqual(unknownFlags(parseArgv(['test', '--filter=t', '--fail-fast'])), []);
    deepStrictEqual(unknownFlags(parseArgv(['pack', 'main.ts', '--out=o.jspack'])), []);
    deepStrictEqual(unknownFlags(parseArgv(['task', '--cwd=/tmp', 'build'])), []);
    deepStrictEqual(unknownFlags(parseArgv(['cache', '--frozen', '--no-http', 'main.ts'])), []);
});
