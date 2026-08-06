import { deepStrictEqual, strictEqual, throws } from 'node:assert';

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
