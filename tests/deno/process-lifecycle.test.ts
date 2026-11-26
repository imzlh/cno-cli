import { deepStrictEqual, rejects, strictEqual, throws } from 'node:assert';

/**
 * The subject here — `status` being a stable promise, post-exit `status` reads
 * staying deterministic, and `kill()` after exit throwing — is platform
 * neutral. Only the exit-4 fixture is platform specific, so this used to be
 * gated `ignore: Deno.build.os === 'windows'` purely because it hardcoded
 * `/bin/sh`, which hid the whole subject on Windows rather than a real
 * platform limit.
 *
 * Oracle (2026-08-03): real Deno 2.9.3 on Windows with `cmd /c exit 4` reports
 * `{ success: false, code: 4, signal: null }` from both awaits, keeps the
 * `status` promise identity stable, and throws "Child process has already
 * terminated" from `kill()`. cno matches on all four points.
 */
const isWindows = Deno.build.os === 'windows';
const exit4 = isWindows
    ? { cmd: 'cmd', args: ['/c', 'exit 4'] }
    : { cmd: '/bin/sh', args: ['-c', 'exit 4'] };

Deno.test({
    name: 'deno process: status is stable and post-exit lifecycle calls are deterministic',
    timeout: 10000,
    fn: async () => {
        const child = new Deno.Command(exit4.cmd, {
            args: exit4.args,
            stdin: 'null',
            stdout: 'null',
            stderr: 'null',
        }).spawn();
        const status = child.status;
        strictEqual(child.status, status);
        deepStrictEqual(await status, { code: 4, success: false, signal: null });
        deepStrictEqual(await child.status, { code: 4, success: false, signal: null });
        throws(() => child.kill(), /already terminated/);
        await child[Symbol.asyncDispose]();
    },
});

Deno.test('deno process: status maps native wait failures and keeps promise identity', async () => {
    const proc = import.meta.use('process');
    const nativeError = import.meta.use('error');
    const descriptor = Object.getOwnPropertyDescriptor(proc, 'spawn')!;
    const waitFailure = nativeError.Error(nativeError.errno.EBADF);
    Object.defineProperty(proc, 'spawn', {
        configurable: true,
        value: () => ({
            pid: 0,
            wait: () => Promise.reject(waitFailure),
            kill() { throw new Error('finished process must not be signalled'); },
        }),
    });
    try {
        const child = new Deno.Command(Deno.execPath(), {
            stdin: 'null',
            stdout: 'null',
            stderr: 'null',
        }).spawn();
        const status = child.status;
        strictEqual(child.status, status);
        await rejects(status, Deno.errors.BadResource);
        strictEqual(child.status, status);
        throws(() => child.kill(), /already terminated/);
        await rejects(child[Symbol.asyncDispose](), Deno.errors.BadResource);
    } finally {
        Object.defineProperty(proc, 'spawn', descriptor);
    }
});

Deno.test('deno process: outputSync classifies launch failures by native code, not text', () => {
    const proc = import.meta.use('process');
    const nativeError = import.meta.use('error');
    const descriptor = Object.getOwnPropertyDescriptor(proc, 'spawnSync')!;
    const command = new Deno.Command(Deno.execPath());
    const unrelated = new Error('fixture mentioning ENOENT');
    const missing = nativeError.Error(nativeError.errno.ENOENT);
    try {
        for (const returnsError of [false, true]) {
            for (const failure of [unrelated, missing]) {
                Object.defineProperty(proc, 'spawnSync', {
                    ...descriptor,
                    value: () => {
                        if (!returnsError) throw failure;
                        return { error: failure };
                    },
                });
                throws(() => command.outputSync(), error => failure === unrelated
                    ? error === unrelated
                    : error instanceof Deno.errors.NotFound);
            }
        }
    } finally {
        Object.defineProperty(proc, 'spawnSync', descriptor);
    }
});
