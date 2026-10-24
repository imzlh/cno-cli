import { doesNotMatch, match, strictEqual } from 'node:assert';
import { decodeUtf8 } from '../_helpers/bytes.ts';

const fatalCall = 'engine.waitIO(new Promise(() => {}), () => true)';
const cases = [
    ['promise job', `Promise.resolve().then(() => ${fatalCall});`],
    ['timer callback', `setTimeout(() => ${fatalCall}, 0);`],
    ['nextTick callback', `process.nextTick(() => ${fatalCall});`],
] as const;

for (const [name, body] of cases) {
    Deno.test({ name: `native fatal error: ${name} prints a diagnostic`, timeout: 15000 }, async () => {
        const child = new Deno.Command(Deno.execPath(), {
            args: ['eval', '--ext=js', `const engine = import.meta.use('engine'); ${body}`],
            stdout: 'piped', stderr: 'piped',
        }).spawn();
        const timer = setTimeout(() => child.kill(), 10000);
        try {
            const result = await child.output();
            const stderr = decodeUtf8(result.stderr);
            strictEqual(result.code, 1, stderr);
            match(stderr, /InternalError: waitIO/);
            match(stderr, /at waitIO \(native\)/);
            doesNotMatch(stderr, /Memory leak:|Assertion .* failed/i);
        } finally {
            clearTimeout(timer);
        }
    });
}

Deno.test({ name: 'native worker exit preserves its status without printing a fatal error', timeout: 15000 }, async () => {
    for (const schedule of ['Promise.resolve().then', 'setTimeout', 'process.nextTick']) {
        const source = `
            const { Worker } = import.meta.use('worker');
            const worker = new Worker({
                __node_workerData: null,
                __cts_entry: 'eval:' + \`
                    const engine = import.meta.use('engine');
                    const worker = import.meta.use('worker');
                    engine.onEvent((name, code) => {
                        if (name === engine.EventType.EXIT) worker.pipe.postMessage(code);
                        return false;
                    });
                    ${schedule}(() => import.meta.use('os').exit(42));
                \`,
            });
            await new Promise((resolve, reject) => {
                const timer = setTimeout(() => { worker.stop(); reject(new Error('worker exit timed out')); }, 3000);
                worker.messagePipe.onmessage = code => {
                    clearTimeout(timer);
                    if (code === 42) resolve(); else reject(new Error('wrong worker status: ' + code));
                };
            });
            worker.terminate();
        `;
        const child = new Deno.Command(Deno.execPath(), {
            args: ['eval', '--ext=js', source], stdout: 'piped', stderr: 'piped',
        }).spawn();
        const timer = setTimeout(() => child.kill(), 10000);
        try {
            const result = await child.output();
            strictEqual(result.code, 0, decodeUtf8(result.stdout) + decodeUtf8(result.stderr));
            doesNotMatch(decodeUtf8(result.stderr), /worker exit|InternalError|Memory leak:|Assertion .* failed/i);
        } finally {
            clearTimeout(timer);
        }
    }
});
