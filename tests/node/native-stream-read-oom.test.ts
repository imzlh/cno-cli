import { doesNotMatch, match, strictEqual } from 'node:assert';
import { fileURLToPath } from 'node:url';

const fixture = fileURLToPath(new URL('./fixtures/stream-read-oom.ts', import.meta.url));

for (const limit of ['32MB', '64MB']) {
    Deno.test({ name: `native streams: ${limit} read OOM releases buffers and read pins`, timeout: 35000 }, async () => {
        const child = new Deno.Command(Deno.execPath(), {
            args: ['--disable-cache', `--memory-limit=${limit}`, 'run', fixture],
            stdout: 'piped', stderr: 'piped',
        }).spawn();
        const timer = setTimeout(() => child.kill(), 30000);
        try {
            const result = await child.output();
            const output = new TextDecoder().decode(result.stdout) + new TextDecoder().decode(result.stderr);
            strictEqual(result.code, 0, output);
            // QuickJS may report a native leak even when the CLI exits with 0.
            doesNotMatch(output, /Memory leak:|malloc_size underflow|Assertion .* failed/i);
            match(output, /PASS: repeated stream-read OOM releases buffers and pins/);
        } finally {
            clearTimeout(timer);
        }
    });
}
