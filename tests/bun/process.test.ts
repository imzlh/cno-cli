import { deepStrictEqual, ok, rejects, strictEqual, throws } from 'node:assert';
import Bun, { spawn, spawnSync } from 'bun';
import { join } from 'node:path';
import { runInNewContext } from 'node:vm';
import { withTempDir } from '../_helpers/temp.ts';
import type { BunProcessResourceUsage } from '../../cno/src/bun/process/types.ts';

const isWindows = Deno.build.os === 'windows';

function assertResourceUsage(usage: BunProcessResourceUsage | undefined): void {
    ok(usage);
    for (const value of [usage.cpuTime.user, usage.cpuTime.system, usage.cpuTime.total]) {
        strictEqual(typeof value, 'bigint');
        ok(value >= 0n);
    }
    strictEqual(usage.cpuTime.total, usage.cpuTime.user + usage.cpuTime.system);
    for (const value of [
        usage.contextSwitches.voluntary, usage.contextSwitches.involuntary,
        usage.maxRSS, usage.messages.sent, usage.messages.received,
        usage.ops.in, usage.ops.out, usage.shmSize, usage.signalCount, usage.swapCount,
    ]) {
        strictEqual(typeof value, 'number');
        ok(Number.isFinite(value) && value >= 0);
    }
    // Linux reports the child's actual peak RSS; an all-zero object is not rusage.
    if (Deno.build.os === 'linux') ok(usage.maxRSS > 0);
}

Deno.test('bun: spawn functions expose Bun function shape', () => {
    for (const [fn, name] of [[spawn, 'spawn'], [spawnSync, 'spawnSync']] as const) {
        strictEqual(fn.name, name);
        strictEqual(fn.length, 1);
        strictEqual(Object.hasOwn(fn, 'prototype'), false);
        throws(() => Reflect.construct(fn, []), TypeError);
    }
});

Deno.test({ name: 'bun: spawnSync returns Buffer output and Bun result state', timeout: 10000 }, () => {
    const result = spawnSync(isWindows
        ? ['cmd.exe', '/d', '/s', '/c', 'echo sync-out & exit /b 7']
        : ['/bin/sh', '-c', 'printf sync-out; printf sync-err >&2; exit 7']);

    strictEqual(spawnSync, Bun.spawnSync);
    strictEqual(result.exitCode, 7);
    strictEqual(result.success, false);
    strictEqual(Buffer.isBuffer(result.stdout), true);
    strictEqual(Buffer.isBuffer(result.stderr), true);
    ok(result.stdout.toString().includes('sync-out'));
    if (!isWindows) strictEqual(result.stderr.toString(), 'sync-err');
    assertResourceUsage(result.resourceUsage);
    ok(result.pid > 0);
    strictEqual('signalCode' in result, false);
});

Deno.test({ name: 'bun: spawn exposes stable lifecycle state and drains output', timeout: 10000 }, async () => {
    let callback: unknown[] | undefined;
    const child = spawn(isWindows
        ? ['cmd.exe', '/d', '/s', '/c', 'echo async-out & exit /b 3']
        : ['/bin/sh', '-c', 'printf async-out; printf async-err >&2; exit 3'], {
        stdout: 'pipe',
        stderr: 'pipe',
        onExit(subprocess, code, signal, error) {
            callback = [this === child, subprocess === child, code, signal, error];
        },
    });

    strictEqual(spawn, Bun.spawn);
    strictEqual(child.exited, child.exited);
    strictEqual(child.exitCode, null);
    strictEqual(child.signalCode, null);
    strictEqual(child.killed, false);
    strictEqual('status' in child, false);
    strictEqual('success' in child, false);
    strictEqual(child.readable, child.stdout);
    strictEqual(await child.stdout.text(), isWindows ? 'async-out\r\n' : 'async-out');
    const stderr = await child.stderr.text();
    if (!isWindows) strictEqual(stderr, 'async-err');
    strictEqual(await child.exited, 3);
    strictEqual(child.exitCode, 3);
    strictEqual(child.signalCode, null);
    strictEqual(child.killed, true);
    // Partial: libuv reaps async children internally, so no per-child rusage
    // exists. undefined is reported rather than a fabricated or shared snapshot.
    strictEqual(child.resourceUsage(), undefined);
    deepStrictEqual(callback, [true, true, 3, null, undefined]);
    strictEqual(child.kill(), undefined);
    strictEqual(child.ref(), undefined);
    strictEqual(child.unref(), undefined);
});

Deno.test({ name: 'bun: spawn FileSink serializes stdin writes and closes with EOF', timeout: 10000 }, async () => {
    const child = spawn(isWindows
        ? ['cmd.exe', '/d', '/s', '/c', 'more']
        : ['/bin/cat'], {
        stdin: 'pipe',
        stdout: 'pipe',
        stderr: 'pipe',
    });
    ok(child.stdin && typeof child.stdin === 'object' && 'write' in child.stdin);
    const sinkPrototype = Object.getPrototypeOf(child.stdin) as Record<string, Function>;
    strictEqual(Object.prototype.toString.call(child.stdin), '[object FileSink]');
    strictEqual(child.stdin.constructor.name, 'FileSink');
    for (const [name, length] of [['start', 1], ['write', 1], ['flush', 1], ['end', 0]] as const) {
        const descriptor = Object.getOwnPropertyDescriptor(sinkPrototype, name)!;
        strictEqual(descriptor.enumerable, true);
        strictEqual(descriptor.writable, false);
        strictEqual(descriptor.configurable, false);
        strictEqual(descriptor.value.length, length);
        throws(() => Reflect.apply(descriptor.value, {}, name === 'write' ? ['x'] : []), {
            name: 'TypeError', message: 'Expected FileSink', code: 'ERR_INVALID_THIS',
        });
    }
    throws(() => new (child.stdin.constructor as new () => object)(), {
        name: 'TypeError', message: 'Illegal constructor', code: 'ERR_ILLEGAL_CONSTRUCTOR',
    });
    strictEqual(Reflect.apply(sinkPrototype.ref, null, []), undefined);
    strictEqual(Reflect.apply(sinkPrototype.unref, {}, []), undefined);

    const readablePrototype = Object.getPrototypeOf(child.stdout) as Record<string, Function>;
    for (const name of ['blob', 'bytes', 'json', 'text']) {
        strictEqual(Object.hasOwn(child.stdout, name), false);
        const descriptor = Object.getOwnPropertyDescriptor(readablePrototype, name)!;
        strictEqual(descriptor.enumerable, true);
        strictEqual(descriptor.writable, true);
        strictEqual(descriptor.configurable, true);
        strictEqual(descriptor.value.length, 0);
        strictEqual(Object.hasOwn(descriptor.value, 'prototype'), false);
        throws(() => Reflect.construct(descriptor.value, []), TypeError);
    }
    child.stdin.start({ highWaterMark: 2 });
    const first = child.stdin.write('abc');
    const second = child.stdin.write(new Uint8Array([100, 101]));
    strictEqual(await first, 3);
    strictEqual(await second, 2);
    strictEqual(await child.stdin.flush(), 5);
    strictEqual(await child.stdin.end(), 0);
    strictEqual(await child.stdout.text(), 'abcde');
    strictEqual(await child.exited, 0);
    strictEqual(child.stdin.write('late'), true);
    strictEqual(child.stdin.flush(), true);
    throws(() => child.stdin.write(null as never), {
        name: 'TypeError',
        message: 'write() expects a string, ArrayBufferView, or ArrayBuffer',
        code: 'ERR_STREAM_NULL_VALUES',
    });
});

Deno.test({ name: 'bun: spawn FileSink uses intrinsic binary brands and view slots', ignore: isWindows, timeout: 10000 }, async () => {
    const child = spawn(['/bin/cat'], { stdin: 'pipe', stdout: 'pipe', stderr: 'ignore' });
    const foreign = runInNewContext(`(() => {
        const buffer = new ArrayBuffer(6);
        new Uint8Array(buffer).set([10, 11, 12, 13, 14, 15]);
        return { buffer, typed: new Uint16Array(buffer, 2, 2), data: new DataView(buffer, 3, 2) };
    })()`);
    for (const value of Object.values(foreign) as object[]) {
        for (const property of ['buffer', 'byteOffset', 'byteLength']) {
            Object.defineProperty(value, property, { get() { throw new Error(`shadowed ${property}`); } });
        }
    }

    strictEqual(await child.stdin.write(foreign.buffer), 6);
    strictEqual(await child.stdin.write(foreign.typed), 4);
    strictEqual(await child.stdin.write(foreign.data), 2);

    const detached = new ArrayBuffer(4);
    const detachedTyped = new Uint8Array(detached, 1, 2);
    const detachedData = new DataView(detached, 1, 2);
    structuredClone(detached, { transfer: [detached] });
    strictEqual(await child.stdin.write(detached), 0);
    strictEqual(await child.stdin.write(detachedTyped), 0);
    strictEqual(await child.stdin.write(detachedData), 0);

    for (const value of [new Proxy(foreign.buffer, {}), new Proxy(foreign.typed, {}), new Proxy(foreign.data, {})]) {
        throws(() => child.stdin.write(value), {
            name: 'TypeError',
            message: 'write() expects a string, ArrayBufferView, or ArrayBuffer',
            code: 'ERR_INVALID_ARG_TYPE',
        });
    }

    const originalIsView = ArrayBuffer.isView;
    let intrinsicWrite: Promise<number> | true;
    try {
        ArrayBuffer.isView = (() => { throw new Error('replacement called'); }) as typeof ArrayBuffer.isView;
        intrinsicWrite = child.stdin.write(new Uint8Array([20, 21]));
    } finally {
        ArrayBuffer.isView = originalIsView;
    }
    strictEqual(await intrinsicWrite!, 2);

    await child.stdin.end();
    deepStrictEqual([...await child.stdout.bytes()], [10, 11, 12, 13, 14, 15, 12, 13, 14, 15, 13, 14, 20, 21]);
    strictEqual(await child.exited, 0);
});

Deno.test({ name: 'bun: spawn and spawnSync replace explicit env and preserve typed-array offsets', timeout: 10000 }, async () => {
    if (isWindows) return;
    await withTempDir('bun-process-env', async (root) => {
        const asyncChild = spawn(['/bin/sh', '-c', 'printf "%s:%s" "$CNO_SET" "${CNO_DROP-unset}"'], {
            cwd: root,
            env: { CNO_SET: 'yes', CNO_DROP: undefined },
            stdout: 'pipe',
            stderr: 'pipe',
        });
        strictEqual(await asyncChild.stdout.text(), 'yes:unset');
        strictEqual(await asyncChild.exited, 0);

        const bytes = new Uint8Array([0, 65, 66, 67, 0]);
        const sync = spawnSync(['/bin/sh', '-c', 'cat'], {
            cwd: root,
            env: { CNO_ONLY: 'value' },
            stdin: bytes.subarray(1, 4),
            stdout: 'pipe',
            stderr: 'pipe',
        });
        strictEqual(sync.stdout.toString(), 'ABC');
        strictEqual(sync.exitCode, 0);
        strictEqual(sync.success, true);
    });
});

Deno.test({ name: 'bun: static Blob stdin uses intrinsic slots and constructors', ignore: isWindows, timeout: 10000 }, async () => {
    const output = async (value: Blob) => {
        const child = spawn(['/bin/cat'], { stdin: value, stdout: 'pipe', stderr: 'pipe' });
        strictEqual(await child.exited, 0);
        return child.stdout.text();
    };
    const syncOutput = (value: Blob) => spawnSync(['/bin/cat'], {
        stdin: value,
        stdout: 'pipe',
        stderr: 'pipe',
    }).stdout.toString();

    const asyncBlob = new Blob(['async-slots']);
    const syncBlob = new File(['sync-slots'], 'stdin.txt');
    Object.setPrototypeOf(asyncBlob, null);
    Object.setPrototypeOf(syncBlob, null);
    strictEqual(await output(asyncBlob), 'async-slots');
    strictEqual(syncOutput(syncBlob), 'sync-slots');

    for (const value of [Object.create(Blob.prototype), new Proxy(new Blob(['proxy']), {})]) {
        throws(() => spawn(['/bin/cat'], { stdin: value }), (error: Error & { code?: string }) =>
            error.code === 'ERR_INVALID_ARG_TYPE');
        throws(() => spawnSync(['/bin/cat'], { stdin: value }), (error: Error & { code?: string }) =>
            error.code === 'ERR_INVALID_ARG_TYPE');
    }

    let getterCalls = 0;
    const getterBlob = new Blob(['intrinsic']);
    for (const name of ['bytes', 'arrayBuffer', 'stream', 'size'] as const) {
        Object.defineProperty(getterBlob, name, { get() { getterCalls++; throw new Error(name); } });
    }
    strictEqual(await output(getterBlob), 'intrinsic');
    strictEqual(syncOutput(getterBlob), 'intrinsic');
    strictEqual(getterCalls, 0);

    const blobDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'Blob')!;
    const fileDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'File')!;
    const oldBlob = new Blob(['old-blob']);
    const oldFile = new File(['old-file'], 'stdin.txt');
    try {
        Reflect.set(globalThis, 'Blob', function ReplacementBlob() {});
        Reflect.set(globalThis, 'File', function ReplacementFile() {});
        strictEqual(await output(oldBlob), 'old-blob');
        strictEqual(syncOutput(oldFile), 'old-file');
    } finally {
        Object.defineProperty(globalThis, 'Blob', blobDescriptor);
        Object.defineProperty(globalThis, 'File', fileDescriptor);
    }
});

Deno.test({ name: 'bun: spawn reports signal termination with Bun exit semantics', ignore: isWindows, timeout: 10000 }, async () => {
    const child = spawn(['/bin/sh', '-c', 'while :; do sleep 1; done'], {
        stdout: 'ignore',
        stderr: 'ignore',
    });
    child.kill('SIGTERM');
    strictEqual(await child.exited, 143);
    strictEqual(child.exitCode, null);
    strictEqual(child.signalCode, 'SIGTERM');
    strictEqual(child.killed, true);

    const sync = spawnSync(['/bin/sh', '-c', 'kill -TERM $$']);
    strictEqual(sync.exitCode, null as never);
    strictEqual(sync.signalCode, 'SIGTERM');
    strictEqual(sync.success, false);
});

Deno.test({ name: 'bun: process validation throws synchronously without launching', timeout: 10000 }, async () => {
    throws(() => spawn([]), (error: Error & { code?: string }) => error.code === 'ERR_INVALID_ARG_TYPE');
    throws(() => spawnSync([]), (error: Error & { code?: string }) => error.code === 'ERR_INVALID_ARG_TYPE');
    throws(() => spawnSync(['/definitely/not/a/cno-command']), (error: Error & { code?: string }) => error.code === 'ENOENT');
    await withTempDir('bun-process-invalid', async (root) => {
        const missing = join(root, 'missing');
        throws(() => spawn(['/bin/sh'], { cwd: missing }), (error: Error & { code?: string }) => error.code === 'ENOENT');
        throws(() => spawnSync(['/bin/sh'], { cwd: missing }), (error: Error & { code?: string }) => error.code === 'ENOENT');
    });

    const controller = new AbortController();
    controller.abort('cancelled');
    throws(() => spawn(['/bin/sh'], { signal: controller.signal }), (error: Error) => error.name === 'AbortError');
    await rejects(async () => {
        const child = spawn(['/bin/sh', '-c', 'sleep 5'], { timeout: 5, stdout: 'ignore', stderr: 'ignore' });
        strictEqual(await child.exited, 143);
        throw new Error('timeout-observed');
    }, /timeout-observed/);
});

Deno.test({ name: 'bun: process rejects NUL bytes, unknown killSignal, and sync-only unsupported argv0', ignore: isWindows, timeout: 10000 }, () => {
    const code = (name: string) => (error: Error & { code?: string }) => error.code === name;
    throws(() => spawnSync(['/bin/echo', 'a\0b']), code('ERR_INVALID_ARG_VALUE'));
    throws(() => spawn(['/bin/echo', 'a\0b']), code('ERR_INVALID_ARG_VALUE'));
    throws(() => spawnSync(['/bin/echo'], { env: { X: 'a\0b' } }), code('ERR_INVALID_ARG_VALUE'));
    throws(() => spawnSync(['/bin/echo'], { cwd: '/tmp\0x' }), code('ERR_INVALID_ARG_VALUE'));
    // A bad name must fail at spawn, not later from a timer or abort callback.
    throws(() => spawn(['/bin/echo'], { killSignal: 'SIGFOO' as never }), code('ERR_UNKNOWN_SIGNAL'));
    throws(() => spawnSync(['/bin/echo'], { argv0: 'x' } as never), /argv0/);
});

Deno.test({ name: 'bun: spawn timeout above the timer limit does not fire immediately', ignore: isWindows, timeout: 10000 }, async () => {
    const child = spawn(['/bin/sh', '-c', 'sleep 0.3; printf done'], {
        timeout: 2 ** 31 + 5,
        stdout: 'pipe',
        stderr: 'ignore',
    });
    strictEqual(await child.stdout.text(), 'done');
    strictEqual(await child.exited, 0);
    strictEqual(child.signalCode, null);
});

Deno.test({ name: 'bun: spawn maxBuffer kills a child that exceeds the stdout limit', ignore: isWindows, timeout: 10000 }, async () => {
    const child = spawn(['/bin/sh', '-c', 'printf 12345678; exec sleep 5'], {
        maxBuffer: 2,
        stdout: 'pipe',
        stderr: 'ignore',
    } as never);
    await child.stdout.text();
    strictEqual(await child.exited, 143);
    strictEqual(child.signalCode, 'SIGTERM');
});

Deno.test({ name: 'bun: FileSink.end treats its argument as metadata and always delivers EOF', ignore: isWindows, timeout: 10000 }, async () => {
    const withTimeout = <T>(promise: Promise<T>, fallback: T) =>
        Promise.race([promise, new Promise<T>((resolve) => setTimeout(() => resolve(fallback), 2000))]);

    const first = spawn(['/bin/cat'], { stdin: 'pipe', stdout: 'pipe' });
    strictEqual(await first.stdin.write('ok'), 2);
    strictEqual(await first.stdin.end('not-an-error' as never), 2);
    strictEqual(await withTimeout(first.stdout.text(), 'HANG'), 'ok');
    strictEqual(first.stdin.write('late'), true);

    const second = spawn(['/bin/cat'], { stdin: 'pipe', stdout: 'pipe' });
    strictEqual(await second.stdin.write('err'), 3);
    strictEqual(await second.stdin.end(new Error('boom')), 3);
    strictEqual(await withTimeout(second.stdout.text(), 'HANG'), 'err');
    strictEqual(await second.exited, 0);
});

Deno.test({ name: 'bun: static stdin ignores early child close instead of killing it', ignore: isWindows, timeout: 10000 }, async () => {
    const child = spawn(['/bin/sh', '-c', 'exec 0<&-; sleep 0.3; printf alive'], {
        stdin: new Uint8Array(1 << 20),
        stdout: 'pipe',
        stderr: 'ignore',
    });
    strictEqual(await child.stdout.text(), 'alive');
    strictEqual(await child.exited, 0);
    strictEqual(child.signalCode, null);
});
