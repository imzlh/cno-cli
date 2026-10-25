import { strictEqual } from 'node:assert';
import { spawn } from 'node:child_process';

const PAYLOAD = 'hello\u4e16\u754c'.repeat(50000);

for (const mode of ['readable', 'flowing'] as const) {
    Deno.test({ name: `child_process: ${mode} stdout drains after backpressure`, timeout: 20000 }, async () => {
        const output = await new Promise<string>((resolve, reject) => {
            const child = spawn(process.execPath, ['-e', 'process.stdout.write("hello\\u4e16\\u754c".repeat(50000))']);
            let text = '';
            const fail = (error: Error) => {
                clearTimeout(timer);
                try { child.kill(); } catch { /* the child may have already exited */ }
                child.stdout?.destroy();
                child.stderr?.destroy();
                reject(error);
            };
            const timer = setTimeout(() => fail(new Error(`${mode} stdout stopped after ${text.length} characters`)), 10000);
            child.on('error', fail);
            child.stdout!.on('error', fail);
            child.stdout!.setEncoding('utf8');
            child.stderr!.resume();
            if (mode === 'readable') {
                child.stdout!.on('readable', () => {
                    let chunk: string | null;
                    while ((chunk = child.stdout!.read()) !== null) text += chunk;
                });
            } else {
                child.stdout!.on('data', (chunk: string) => {
                    text += chunk;
                    child.stdout!.pause();
                    setTimeout(() => child.stdout!.resume(), 1);
                });
            }
            child.on('close', code => {
                clearTimeout(timer);
                if (code !== 0) reject(new Error(`child exited with ${code}`));
                else resolve(text);
            });
        });
        strictEqual(output, PAYLOAD);
    });
}
