import { deepStrictEqual, strictEqual, ok, throws } from 'node:assert';
import { spawnSync } from 'node:child_process';
import * as process from 'node:process';
import processDefault from 'node:process';

// --- 1. process.pid / ppid / threadId -------------------------------------

Deno.test('process: pid and ppid are positive integers', () => {
    ok(Number.isInteger(process.pid) && process.pid > 0);
    ok(Number.isInteger(process.ppid) && process.ppid >= 0);
});

// --- 2. process.argv is a non-empty array of strings ----------------------

Deno.test('process: argv is array of strings', () => {
    ok(Array.isArray(process.argv));
    ok(process.argv.length >= 1);
    for (const a of process.argv) ok(typeof a === 'string');
});

// --- 3. process.execPath / mainModule -------------------------------------

Deno.test('process: execPath is a string', () => {
    ok(typeof process.execPath === 'string' && process.execPath.length > 0);
});

Deno.test('process upstream: execPath and deprecated mainModule are writable', () => {
    const mutable = require('node:process') as typeof process & {
        execPath: string;
        mainModule?: unknown;
    };
    const originalExecPath = mutable.execPath;
    const originalMainModule = mutable.mainModule;

    try {
        mutable.execPath = '/path/to/node';
        strictEqual(mutable.execPath, '/path/to/node');

        strictEqual(mutable.mainModule, undefined);
        mutable.mainModule = 'foo';
        strictEqual(mutable.mainModule, 'foo');
    } finally {
        mutable.execPath = originalExecPath;
        mutable.mainModule = originalMainModule;
    }
});

// --- 4. process.cwd / chdir round-trip ------------------------------------

Deno.test('process: cwd and chdir round-trip', () => {
    const original = process.cwd();
    ok(typeof original === 'string' && original.length > 0);
    process.chdir('/');
    strictEqual(process.cwd(), '/');
    process.chdir(original);
    strictEqual(process.cwd(), original);
});

Deno.test('process upstream: chdir failure is a Node-style ENOENT error', () => {
    throws(
        () => process.chdir('non-existent-directory-name-for-cno-tests'),
        (err: NodeJS.ErrnoException) => {
            strictEqual(err.code, 'ENOENT');
            strictEqual(err.syscall, 'chdir');
            strictEqual(err.path, 'non-existent-directory-name-for-cno-tests');
            return true;
        },
    );
});

// --- 5. process.env: get/set/delete ---------------------------------------

Deno.test('process: env get/set/delete', () => {
    const key = 'CNO_PROCESS_ENV_KEY';
    process.env[key] = 'v1';
    strictEqual(process.env[key], 'v1');
    ok(key in process.env);
    delete process.env[key];
    strictEqual(process.env[key], undefined);
    ok(!(key in process.env));
});

Deno.test('process: env.toString and indexing', () => {
    process.env['CNO_ENV_STR'] = 'x';
    ok(typeof process.env['CNO_ENV_STR'] === 'string');
    delete process.env['CNO_ENV_STR'];
});

Deno.test('process: env coerces assigned non-string values to strings', () => {
    const key = 'CNO_ENV_NUM';
    (process.env as Record<string, any>)[key] = 123;
    strictEqual(process.env[key], '123');
    delete process.env[key];
});

Deno.test('process upstream: env preserves empty strings and tolerates invalid and symbol keys', () => {
    const emptyKey = 'TEST_ENV_VAR_EMPTY_STRING';
    process.env[emptyKey] = '';
    try {
        strictEqual(process.env[emptyKey], '');
        ok(Object.keys(process.env).includes(emptyKey));
        ok(emptyKey in process.env);
        ok(Object.hasOwn(process.env, emptyKey));
    } finally {
        delete process.env[emptyKey];
    }

    strictEqual(process.env[''], undefined);
    strictEqual(process.env['\0'], undefined);
    strictEqual(process.env['=c:'], undefined);
    strictEqual('' in process.env, false);
    strictEqual('\0' in process.env, false);
    strictEqual('=c:' in process.env, false);

    const symbol = Symbol.for('cno-process-env-symbol');
    (process.env as Record<symbol, string>)[symbol] = 'symbol-value';
    try {
        strictEqual((process.env as Record<symbol, string>)[symbol], 'symbol-value');
        strictEqual(Reflect.has(process.env, symbol), true);
    } finally {
        delete (process.env as Record<symbol, string>)[symbol];
    }
    strictEqual(Reflect.has(process.env, symbol), false);
});

// --- 6. process.platform / arch / version --------------------------------

Deno.test('process: platform/arch/version are strings', () => {
    for (const k of ['platform', 'arch', 'version'] as const) {
        const value = process[k];
        ok(typeof value === 'string' && value.length > 0, `process.${k} must be a non-empty string`);
    }
});

// --- 7. process.versions has node + at least one engine ------------------

Deno.test('process: versions.node exists', () => {
    ok(typeof process.versions.node === 'string');
    ok(process.versions.node.length > 0);
});

Deno.test('process upstream: versions exposes Node and Deno compatibility fields', () => {
    const versions = process.versions as Record<string, string | undefined>;
    for (const key of [
        'node',
        'v8',
        'uv',
        'zlib',
        'brotli',
        'ares',
        'modules',
        'nghttp2',
        'napi',
        'llhttp',
        'openssl',
        'cldr',
        'icu',
        'tz',
        'unicode',
        'deno',
        'typescript',
    ] as const) {
        strictEqual(typeof versions[key], 'string', `process.versions.${key}`);
    }
});

// --- 8. process.memoryUsage returns numeric fields ------------------------

Deno.test('process: memoryUsage returns numeric fields', () => {
    const m = process.memoryUsage();
    for (const k of ['rss', 'heapTotal', 'heapUsed', 'external', 'arrayBuffers']) {
        const v = (m as Record<string, number>)[k];
        ok(typeof v === 'number' && v >= 0, `memoryUsage.${k} must be a non-negative number`);
    }
});

Deno.test('process upstream: memoryUsage.rss returns a numeric resident set size', () => {
    strictEqual(typeof process.memoryUsage.rss, 'function');
    const rss = process.memoryUsage.rss();
    ok(typeof rss === 'number' && rss >= 0);
});

// --- 9: process.uptime returns positive number ----------------------------

Deno.test('process: uptime is positive', () => {
    ok(typeof process.uptime() === 'number' && process.uptime() >= 0);
});

Deno.test('process upstream: uptime works without this binding', () => {
    const uptime = (0, process.uptime)();
    ok(typeof uptime === 'number' && uptime >= 0);
});

Deno.test('process upstream: constructor can be called without new', () => {
    (processDefault.constructor as unknown as { call(target: object): void }).call({});
});

// --- 10. process.hrtime.bigint returns bigint -----------------------------

Deno.test('process: hrtime.bigint returns bigint', () => {
    const t = process.hrtime.bigint();
    ok(typeof t === 'bigint');
    const t2 = process.hrtime.bigint();
    ok(t2 >= t, 'hrtime.bigint must be monotonic');
});

// --- 11. process.hrtime() array form --------------------------------------

Deno.test('process: hrtime() returns [seconds, nanoseconds]', () => {
    const [s, ns] = process.hrtime();
    ok(Number.isInteger(s) && s >= 0);
    ok(Number.isInteger(ns) && ns >= 0);
});

Deno.test('process: hrtime(previous) returns a non-negative diff tuple', async () => {
    const start = process.hrtime();
    await new Promise((r) => setTimeout(r, 5));
    const diff = process.hrtime(start);
    strictEqual(diff.length, 2);
    ok(Number.isInteger(diff[0]) && diff[0] >= 0);
    ok(Number.isInteger(diff[1]) && diff[1] >= 0);
});

// --- 12. process.kill with signal 0 checks pid liveness ------------------

Deno.test('process: kill(pid, 0) checks own pid without killing', () => {
    // signal 0 does not actually send a signal, just checks liveness
    let threw = false;
    try { process.kill(process.pid, 0); } catch { threw = true; }
    ok(!threw, 'kill(self, 0) must not throw for a live process');
});

// --- 13. process.kill on nonexistent pid throws ---------------------------

Deno.test('process: kill(veryLargePid) throws ESRCH', () => {
    let threw = false;
    try { process.kill(99999999, 0); } catch (e: unknown) {
        threw = true;
        ok((e as NodeJS.ErrnoException).code === 'ESRCH', `expected ESRCH, got ${(e as NodeJS.ErrnoException).code}`);
    }
    ok(threw, 'kill on nonexistent pid must throw');
});

// --- 14. process.nextTick defers ------------------------------------------

Deno.test('process: nextTick defers after current work', async () => {
    let order = '';
    order += 'a';
    process.nextTick(() => { order += 'b'; });
    order += 'c';
    await new Promise((r) => setTimeout(r, 10));
    strictEqual(order, 'acb');
});

// --- 15. process.nextTick passes args -------------------------------------

Deno.test('process: nextTick forwards arguments', async () => {
    const received = await new Promise<any[]>((resolve) => {
        process.nextTick((a: number, b: string) => resolve([a, b]), 1, 'two');
    });
    strictEqual(received[0], 1);
    strictEqual(received[1], 'two');
});

Deno.test('process: nextTick runs before Promise jobs queued in the same turn', async () => {
    const order: string[] = [];
    process.nextTick(() => order.push('tick1'));
    Promise.resolve().then(() => order.push('promise'));
    process.nextTick(() => order.push('tick2'));
    await new Promise((r) => setTimeout(r, 10));
    strictEqual(order.join(','), 'tick1,tick2,promise');
});

Deno.test('process upstream: uncaughtException catches errors thrown from nextTick', async () => {
    const error = new Error('thrown from next tick');
    const caught = await new Promise<unknown>((resolve, reject) => {
        const timeout = setTimeout(() => {
            process.off('uncaughtException', onUncaught);
            reject(new Error('uncaughtException was not emitted'));
        }, 50);
        const onUncaught = (value: unknown) => {
            clearTimeout(timeout);
            process.off('uncaughtException', onUncaught);
            resolve(value);
        };
        process.on('uncaughtException', onUncaught);
        process.nextTick(() => {
            throw error;
        });
    });
    strictEqual(caught, error);
});

// --- 16. process.exit must not be called in tests (smoke only) ------------

Deno.test('process: exitCode defaults to 0 or undefined', () => {
    ok(process.exitCode === undefined || typeof process.exitCode === 'number');
});

Deno.test('process upstream: default export exposes writable process fields', () => {
    const mutable = processDefault as typeof processDefault & {
        mainModule?: unknown;
        execPath: string;
        exitCode?: unknown;
    };
    const originalMainModule = mutable.mainModule;
    const originalExecPath = mutable.execPath;
    const originalExitCode = mutable.exitCode;

    try {
        mutable.mainModule = 'foo';
        strictEqual(mutable.mainModule, 'foo');
        mutable.execPath = '/path/to/node';
        strictEqual(mutable.execPath, '/path/to/node');
        mutable.exitCode = 10;
        strictEqual(mutable.exitCode, 10);
        mutable.exitCode = '0x10';
        strictEqual(mutable.exitCode, 16);
        throws(() => { mutable.exitCode = 'asdf'; }, TypeError);
    } finally {
        mutable.mainModule = originalMainModule;
        mutable.execPath = originalExecPath;
        mutable.exitCode = originalExitCode;
    }
});

Deno.test('process upstream: process.exitCode controls normal subprocess exit', () => {
    const numeric = spawnSync(process.execPath, ['eval', 'process.exitCode = 7'], { encoding: 'utf8' });
    strictEqual(numeric.status, 7);

    const string = spawnSync(process.execPath, ['eval', 'process.exitCode = "0x10"'], { encoding: 'utf8' });
    strictEqual(string.status, 16);
});

// --- 17. process.stdin/stdout/stderr are nullable streams -----------------

Deno.test('process: stdin/stdout/stderr exist', () => {
    ok(process.stdin === null || typeof process.stdin === 'object');
    ok(process.stdout === null || typeof process.stdout === 'object');
    ok(process.stderr === null || typeof process.stderr === 'object');
});

Deno.test('process upstream: stdio exposes fd and writable tty size fields', () => {
    strictEqual(process.stdin.fd, 0);
    strictEqual(process.stdout.fd, 1);
    strictEqual(process.stderr.fd, 2);

    const originalStdinTTY = process.stdin.isTTY;
    const originalStdoutTTY = process.stdout.isTTY;
    const originalColumns = process.stdout.columns;
    try {
        process.stdin.isTTY = !originalStdinTTY;
        strictEqual(process.stdin.isTTY, !originalStdinTTY);
        process.stdout.isTTY = !originalStdoutTTY;
        strictEqual(process.stdout.isTTY, !originalStdoutTTY);
        process.stdout.columns = 80;
        strictEqual(process.stdout.columns, 80);
    } finally {
        process.stdin.isTTY = originalStdinTTY;
        process.stdout.isTTY = originalStdoutTTY;
        process.stdout.columns = originalColumns;
    }
});

// --- 18. process.umask returns a number ----------------------------------

Deno.test('process: umask() returns a number', () => {
    const m = process.umask();
    ok(typeof m === 'number');
});

Deno.test('process: argv0 and execArgv have Node-like shapes', () => {
    ok(typeof process.argv0 === 'string');
    ok(Array.isArray(process.execArgv));
    strictEqual(process.execArgv.length, 0);
    ok(Array.isArray(process.execArgv.slice(0)));
});

Deno.test('process: title is a non-empty string', () => {
    ok(typeof process.title === 'string');
    ok(process.title.length > 0);
});

Deno.test('process: emitWarning emits warning event with code and detail', async () => {
    const warnings: Array<{ name: string; message: string; code?: string; detail?: string }> = [];
    const onWarning = (warning: Error & { code?: string; detail?: string }) => {
        warnings.push({
            name: warning.name,
            message: warning.message,
            code: warning.code,
            detail: warning.detail,
        });
    };

    process.on('warning', onWarning);
    try {
        process.emitWarning('warn-message', { code: 'CODE1', detail: 'detail-text' });
        await new Promise((resolve) => setTimeout(resolve, 20));
    } finally {
        process.off('warning', onWarning);
    }

    strictEqual(warnings.length, 1);
    strictEqual(warnings[0]!.name, 'Warning');
    strictEqual(warnings[0]!.message, 'warn-message');
    strictEqual(warnings[0]!.code, 'CODE1');
    strictEqual(warnings[0]!.detail, 'detail-text');
});

Deno.test('process: rawListeners exposes once wrapper and removeAllListeners clears event', () => {
    const event = 'cno-process-temp';
    const regular = () => {};
    const once = () => {};

    process.on(event, regular);
    process.once(event, once);

    try {
        strictEqual(process.listenerCount(event), 2);
        const raw = process.rawListeners(event);
        strictEqual(raw.length, 2);
        strictEqual(raw[0], regular);
        ok(typeof (raw[1] as typeof raw[1] & { listener?: unknown }).listener === 'function');
        strictEqual((raw[1] as typeof raw[1] & { listener?: unknown }).listener, once);
    } finally {
        process.removeAllListeners(event);
    }

    strictEqual(process.listenerCount(event), 0);
});

Deno.test('process upstream: unimplemented event names still use EventEmitter listener APIs', () => {
    const events = [
        'beforeExit',
        'disconnect',
        'message',
        'multipleResolves',
        'rejectionHandled',
        'uncaughtException',
        'uncaughtExceptionMonitor',
        'unhandledRejection',
        'worker',
    ];
    const handler = () => {};
    for (const event of events) {
        process.on(event, handler);
        strictEqual(process.listenerCount(event), 1);
        process.off(event, handler);
        strictEqual(process.listenerCount(event), 0);
        process.on(event, handler);
        strictEqual(process.listenerCount(event), 1);
        process.removeListener(event, handler);
        strictEqual(process.listenerCount(event), 0);
    }
});

Deno.test('process upstream: signal event listeners are exposed through listeners()', () => {
    const first = () => {};
    const second = () => {};

    process.on('SIGINT', first);
    process.prependListener('SIGINT', second);
    try {
        const listeners = process.listeners('SIGINT');
        strictEqual(listeners.length, 2);
        strictEqual(listeners[0], second);
        strictEqual(listeners[1], first);
    } finally {
        process.off('SIGINT', first);
        process.off('SIGINT', second);
    }

    strictEqual(process.listeners('SIGINT').length, 0);
});

Deno.test('process: setMaxListeners returns process and updates getMaxListeners', () => {
    const previous = process.getMaxListeners();
    try {
        strictEqual(process.setMaxListeners(17), processDefault);
        strictEqual(process.getMaxListeners(), 17);
    } finally {
        process.setMaxListeners(previous);
    }
});

Deno.test('process: allowedNodeEnvironmentFlags accepts value forms for known flags', () => {
    ok(process.allowedNodeEnvironmentFlags.has('--inspect'));
    ok(process.allowedNodeEnvironmentFlags.has('--inspect=9229'));
    ok(process.allowedNodeEnvironmentFlags.has('--inspect-brk=127.0.0.1:9229'));
    ok(process.allowedNodeEnvironmentFlags.has('--require=./setup.js'));
    ok(process.allowedNodeEnvironmentFlags.has('--import=./setup.mjs'));
    ok(!process.allowedNodeEnvironmentFlags.has('--not-a-real-node-flag=1'));
});

Deno.test('process: getBuiltinModule resolves node builtins', () => {
    const path = process.getBuiltinModule('node:path') as typeof import('node:path') | undefined;
    ok(path);
    strictEqual(typeof path!.join, 'function');
    strictEqual(process.getBuiltinModule('node:not-real'), undefined);
});

Deno.test('process upstream: versions, execArgv and sourceMapsEnabled have Node-compatible shapes', () => {
    ok(Object.prototype.hasOwnProperty.call(process, 'versions'));
    strictEqual(processDefault.versions, process.versions);
    ok(Array.isArray(process.execArgv));
    ok(Array.isArray(process.moduleLoadList));
    ok(process.moduleLoadList.every((entry) => typeof entry === 'string'));
    strictEqual(process.sourceMapsEnabled, true);
    process.setSourceMapsEnabled(false);
    process.setSourceMapsEnabled(true);
    strictEqual(process.sourceMapsEnabled, true);
});

Deno.test('process upstream: moduleLoadList is exposed as an initially empty array', () => {
    ok(Array.isArray(process.moduleLoadList));
    strictEqual(process.moduleLoadList.length, 0);
});

Deno.test('process upstream: config exiting uid and gid expose Node-compatible public shape', () => {
    const extended = process as typeof process & {
        config?: { target_defaults?: unknown; variables?: unknown };
        _exiting?: boolean;
        getgid?: () => number | null;
        getuid?: () => number | null;
        geteuid?: () => number | null;
    };

    ok(extended.config);
    ok(extended.config.target_defaults);
    ok(extended.config.variables);
    strictEqual(extended._exiting, false);

    if (Deno.build.os === 'windows') {
        strictEqual(extended.getgid, undefined);
        strictEqual(extended.getuid, undefined);
        strictEqual(extended.geteuid, undefined);
    } else {
        strictEqual(extended.getgid?.(), Deno.gid());
        strictEqual(extended.getuid?.(), Deno.uid());
        strictEqual(typeof extended.geteuid?.(), 'number');
    }
});

Deno.test('process upstream: report exposes basic public report API shape', () => {
    ok(process.report);
    strictEqual(typeof process.report.directory, 'string');
    strictEqual(typeof process.report.filename, 'string');
    strictEqual(typeof process.report.getReport, 'function');
    strictEqual(typeof process.report.writeReport, 'function');
    strictEqual(typeof process.report.reportOnFatalError, 'boolean');
    strictEqual(typeof process.report.reportOnSignal, 'boolean');
    strictEqual(typeof process.report.reportOnUncaughtException, 'boolean');
    strictEqual(process.report.writeReport(), '');
});

Deno.test('process upstream: binding("uv") exposes errno lookup maps', () => {
    const uv = (process as unknown as {
        binding(id: 'uv'): {
            errname(code: number): string;
            getErrorMessage(code: number): string;
            getErrorMap(): Map<number, [string, string]>;
            getCodeMap(): Map<string, number>;
        };
    }).binding('uv');

    strictEqual(uv.errname(-1), 'EPERM');
    strictEqual(uv.getErrorMessage(-1), 'operation not permitted');
    deepStrictEqual(uv.getErrorMap().get(-1), ['EPERM', 'operation not permitted']);
    strictEqual(uv.getCodeMap().get('EPERM'), -1);
});

Deno.test('process upstream: cpuUsage reports current usage and validates previous values', () => {
    strictEqual(process.cpuUsage.length, 1);

    const first = process.cpuUsage();
    ok(typeof first.user === 'number');
    ok(typeof first.system === 'number');

    const second = process.cpuUsage(first);
    ok(first.user >= second.user);
    ok(first.system >= second.system);

    throws(() => process.cpuUsage({} as NodeJS.CpuUsage), TypeError);
    throws(() => process.cpuUsage({ user: '1', system: 2 } as unknown as NodeJS.CpuUsage), TypeError);
    throws(() => process.cpuUsage({ user: 1, system: '2' } as unknown as NodeJS.CpuUsage), TypeError);

    for (const invalidNumber of [-1, -Infinity, Infinity, NaN]) {
        throws(() => process.cpuUsage({ user: invalidNumber, system: 2 }), RangeError);
        throws(() => process.cpuUsage({ user: 2, system: invalidNumber }), RangeError);
    }
});
