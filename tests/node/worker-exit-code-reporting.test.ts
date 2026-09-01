import { strictEqual } from 'node:assert';
import { Worker } from 'node:worker_threads';

// Worker exit status must not depend on importing node:worker_threads.

/** Runs an eval worker and resolves the code its 'exit' event carries. */
function exitCodeOf(source: string, timeoutMs = 10000): Promise<number | 'timeout'> {
    const worker = new Worker(source, { eval: true });
    return new Promise<number | 'timeout'>((resolve) => {
        let settled = false;
        let timer: ReturnType<typeof setTimeout>;
        const done = (v: number | 'timeout') => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            resolve(v);
        };
        worker.on('error', () => {});
        worker.on('exit', (code: number) => done(code));
        timer = setTimeout(() => {
            void worker.terminate();
            done('timeout');
        }, timeoutMs);
        if (typeof (timer as { unref?: () => void }).unref === 'function') {
            (timer as { unref: () => void }).unref();
        }
    });
}

Deno.test({
    name: 'worker_threads: process.exit(code) reports the code without importing worker_threads',
    timeout: 20000,
}, async () => {
    strictEqual(await exitCodeOf(`require('node:process').exit(42)`), 42);
});

Deno.test({
    name: 'worker_threads: a nonzero exit code is not flattened to a success',
    timeout: 20000,
}, async () => {
    const code = await exitCodeOf(`require('node:process').exit(1)`);
    strictEqual(code, 1);
});

Deno.test({
    name: 'worker_threads: exit code survives when the worker imports worker_threads too',
    timeout: 20000,
}, async () => {
    strictEqual(await exitCodeOf(`require('node:worker_threads'); require('node:process').exit(7)`), 7);
});

Deno.test({
    name: 'worker_threads: a worker that ends normally still reports 0',
    timeout: 20000,
}, async () => {
    strictEqual(await exitCodeOf(`require('node:process');`), 0);
});

Deno.test({
    name: 'worker_threads: a worker without a process exit reporter still emits exit on pipe close',
    timeout: 20000,
}, async () => {
    const worker = new Worker('0', { eval: true });
    const code = await new Promise<number>((resolve, reject) => {
        const timer = setTimeout(() => {
            void worker.terminate();
            reject(new Error('worker pipe close did not produce an exit event'));
        }, 10000);
        worker.once('exit', (exitCode: number) => {
            clearTimeout(timer);
            resolve(exitCode);
        });
        worker.once('error', reject);
    });
    strictEqual(code, 0);
});
