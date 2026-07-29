import { deepStrictEqual, strictEqual, throws } from 'node:assert';

Deno.test({
    name: 'deno process: status is stable and post-exit lifecycle calls are deterministic',
    ignore: Deno.build.os === 'windows',
    timeout: 10000,
    fn: async () => {
        const child = new Deno.Command('/bin/sh', {
            args: ['-c', 'exit 4'],
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
