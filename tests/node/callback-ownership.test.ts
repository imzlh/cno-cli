import { strictEqual } from 'node:assert';

Deno.test({
    name: 'callback APIs invoke the callback once and preserve errors thrown by it',
    timeout: 10000,
    async fn() {
        const code = `
            const { deepStrictEqual, strictEqual } = await import('node:assert');
            const fs = await import('node:fs');
            const zlib = await import('node:zlib');
            const { tmpdir } = await import('node:os');
            const { join } = await import('node:path');
            const root = fs.mkdtempSync(join(tmpdir(), 'cno-callback-owner-'));
            const file = join(root, 'io');
            fs.writeFileSync(file, 'abc');
            const fd = fs.openSync(file, 'r+');
            const dir = fs.opendirSync(root);
            const cases = [
                ['readv', callback => fs.readv(fd, [Buffer.alloc(1)], 0, callback), null],
                ['writev', callback => fs.writev(fd, [Buffer.from('x')], 0, callback), null],
                ['Dir.close', callback => dir.close(callback), null],
                ['gzip', callback => zlib.gzip('payload', callback), null],
                ['readv failure', callback => fs.readv(0x7fffffff, [Buffer.alloc(1)], 0, callback), 'EBADF'],
                ['writev failure', callback => fs.writev(0x7fffffff, [Buffer.from('x')], 0, callback), 'EBADF'],
                ['Dir.close failure', callback => dir.close(callback), 'ERR_DIR_CLOSED'],
                ['gunzip failure', callback => zlib.gunzip('invalid', callback), 'Z_DATA_ERROR'],
            ];
            try {
                for (const [name, run, expectedCode] of cases) {
                    const fault = new Error(name);
                    const calls = [];
                    const uncaught = [];
                    const onUncaught = error => { uncaught.push(error); };
                    process.on('uncaughtException', onUncaught);
                    process.on('unhandledRejection', onUncaught);
                    try {
                        await new Promise(resolve => {
                            run(error => {
                                calls.push(error?.code ?? null);
                                if (calls.length === 1) {
                                    setTimeout(resolve, 0);
                                    throw fault;
                                }
                            });
                        });
                        deepStrictEqual(calls, [expectedCode], name);
                        strictEqual(uncaught.length, 1, name);
                        strictEqual(uncaught[0], fault, name);
                    } finally {
                        process.off('uncaughtException', onUncaught);
                        process.off('unhandledRejection', onUncaught);
                    }
                }
            } finally {
                fs.closeSync(fd);
                fs.rmSync(root, { recursive: true, force: true });
            }
            console.log('callback-ownership-ok');
        `;
        const controller = new AbortController();
        const deadline = setTimeout(() => controller.abort(), 8000);
        try {
            const output = await new Deno.Command(Deno.execPath(), {
                args: ['eval', code],
                signal: controller.signal,
                stdout: 'piped',
                stderr: 'piped',
            }).output();
            const stderr = new TextDecoder().decode(output.stderr);
            strictEqual(output.code, 0, stderr);
            strictEqual(new TextDecoder().decode(output.stdout).trim(), 'callback-ownership-ok', stderr);
        } finally {
            clearTimeout(deadline);
        }
    },
});
