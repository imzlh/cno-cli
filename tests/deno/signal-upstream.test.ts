// Derived from Deno upstream unit/signal_test.ts public signal semantics.
import { ok, strictEqual } from 'node:assert';
import { decodeUtf8 } from '../_helpers/bytes.ts';

async function runSignalEval(code: string): Promise<{ code: number; signal: Deno.Signal | null; stdout: string; stderr: string }> {
    const output = await new Deno.Command(Deno.execPath(), {
        args: ['eval', `
            const fail = setTimeout(() => {
                console.error('signal test timed out');
                Deno.exit(70);
            }, 1500);
            try {
                ${code}
            } finally {
                clearTimeout(fail);
            }
        `],
        stdout: 'piped',
        stderr: 'piped',
    }).output();
    return {
        code: output.code,
        signal: output.signal,
        stdout: decodeUtf8(output.stdout),
        stderr: decodeUtf8(output.stderr),
    };
}

const waitFor = `
    async function waitFor(predicate) {
        while (!predicate()) await new Promise((resolve) => setTimeout(resolve, 10));
    }
`;

Deno.test({
    name: 'deno signal upstream: addSignalListener receives repeated self signals',
    ignore: Deno.build.os === 'windows',
    timeout: 10000,
}, async () => {
    const child = await runSignalEval(`
        ${waitFor}
        let count = 0;
        const listener = () => count++;
        Deno.addSignalListener('SIGUSR1', listener);
        for (let i = 1; i <= 3; i++) {
            Deno.kill(Deno.pid, 'SIGUSR1');
            await waitFor(() => count === i);
        }
        Deno.removeSignalListener('SIGUSR1', listener);
        console.log(count);
    `);
    strictEqual(child.code, 0, child.stderr);
    strictEqual(child.signal, null);
    strictEqual(child.stdout, '3\n');
});

Deno.test({
    name: 'deno signal upstream: multiple listeners and removal are ordered per signal',
    ignore: Deno.build.os === 'windows',
    timeout: 10000,
}, async () => {
    const child = await runSignalEval(`
        ${waitFor}
        let text = '';
        const first = () => { text += '0'; };
        const second = () => { text += '1'; };
        Deno.addSignalListener('SIGUSR2', first);
        Deno.addSignalListener('SIGUSR2', second);
        Deno.kill(Deno.pid, 'SIGUSR2');
        await waitFor(() => text.length === 2);
        Deno.removeSignalListener('SIGUSR2', second);
        Deno.kill(Deno.pid, 'SIGUSR2');
        await waitFor(() => text.length === 3);
        Deno.removeSignalListener('SIGUSR2', first);
        console.log(text);
    `);
    strictEqual(child.code, 0, child.stderr);
    strictEqual(child.signal, null);
    strictEqual(child.stdout, '010\n');
});

Deno.test({
    name: 'deno signal upstream: duplicate listener is registered once',
    ignore: Deno.build.os === 'windows',
    timeout: 10000,
}, async () => {
    const child = await runSignalEval(`
        ${waitFor}
        let count = 0;
        const listener = () => count++;
        Deno.addSignalListener('SIGUSR1', listener);
        Deno.addSignalListener('SIGUSR1', listener);
        Deno.kill(Deno.pid, 'SIGUSR1');
        await waitFor(() => count === 1);
        Deno.removeSignalListener('SIGUSR1', listener);
        console.log(count);
    `);
    strictEqual(child.code, 0, child.stderr);
    strictEqual(child.signal, null);
    strictEqual(child.stdout, '1\n');
});

Deno.test({
    name: 'deno signal upstream: removed listener can be added again',
    ignore: Deno.build.os === 'windows',
    timeout: 10000,
}, async () => {
    const child = await runSignalEval(`
        ${waitFor}
        let count = 0;
        const listener = () => count++;
        Deno.addSignalListener('SIGUSR1', listener);
        Deno.removeSignalListener('SIGUSR1', listener);
        Deno.addSignalListener('SIGUSR1', listener);
        Deno.kill(Deno.pid, 'SIGUSR1');
        await waitFor(() => count === 1);
        Deno.removeSignalListener('SIGUSR1', listener);
        console.log(count);
    `);
    strictEqual(child.code, 0, child.stderr);
    strictEqual(child.signal, null);
    strictEqual(child.stdout, '1\n');
});

Deno.test({
    name: 'deno signal upstream: subprocess can exit while listening',
    timeout: 10000,
}, async () => {
    const output = await new Deno.Command(Deno.execPath(), {
        args: ['eval', "Deno.addSignalListener('SIGINT', () => {})"],
        stdout: 'piped',
        stderr: 'piped',
    }).output();
    strictEqual(output.code, 0, decodeUtf8(output.stderr));
    strictEqual(output.signal, null);
    ok(output.success);
});
