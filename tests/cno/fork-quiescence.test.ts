import { ok, strictEqual } from 'node:assert';

const isWindows = Deno.build.os === 'windows';

async function runProbe(source: string): Promise<string> {
    const file = Deno.makeTempFileSync({ prefix: 'cno-fork-quiescence-', suffix: '.mjs' });
    try {
        Deno.writeTextFileSync(file, source);
        const output = await new Deno.Command(Deno.execPath(), {
            args: ['run', file],
            stdout: 'piped',
            stderr: 'piped',
            env: { CTS_SILENT: 'true' },
        }).output();
        strictEqual(output.code, 0, new TextDecoder().decode(output.stderr));
        return new TextDecoder().decode(output.stdout);
    } finally {
        Deno.removeSync(file);
    }
}

Deno.test({
    name: 'native process.fork rejects while a libuv request is pending',
    ignore: isWindows,
    timeout: 20000,
}, async () => {
    const output = await runProbe(`
        const processNative = import.meta.use('process');
        const read = Deno.readFile(new URL(import.meta.url));
        try {
            processNative.fork();
            console.log('forked');
        } catch (error) {
            console.log(String(error.message));
        }
        await read;
    `);
    ok(output.includes('requires an idle event loop'), output);
    ok(!output.includes('forked'), output);
});

Deno.test({
    name: 'native process.fork rejects while a promise job is pending',
    ignore: isWindows,
    timeout: 20000,
}, async () => {
    const output = await runProbe(`
        const processNative = import.meta.use('process');
        Promise.resolve().then(() => {});
        try {
            processNative.fork();
            console.log('forked');
        } catch (error) {
            console.log(String(error.message));
        }
    `);
    ok(output.includes('requires an idle event loop'), output);
    ok(!output.includes('forked'), output);
});

Deno.test({
    name: 'native process.fork rejects while an unrefed libuv handle is active',
    ignore: isWindows,
    timeout: 20000,
}, async () => {
    const output = await runProbe(`
        const processNative = import.meta.use('process');
        const timers = import.meta.use('timers');
        const id = timers.setTimeout(() => {}, 60_000);
        timers.unrefTimer(id);
        try {
            processNative.fork();
            console.log('forked');
        } catch (error) {
            console.log(String(error.message));
        } finally {
            timers.clearTimeout(id);
        }
    `);
    ok(output.includes('requires an idle event loop'), output);
    ok(!output.includes('forked'), output);
});
