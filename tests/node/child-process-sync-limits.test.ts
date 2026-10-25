import { strictEqual, throws } from 'node:assert';
import { Buffer } from 'node:buffer';
import { execFileSync, spawnSync } from 'node:child_process';

Deno.test('child_process: spawnSync limits UTF-8 bytes before decoding', () => {
    const result = spawnSync(process.execPath, ['-e', 'process.stdout.write("\\u00e9".repeat(700))'], {
        encoding: 'utf8', maxBuffer: 1000,
    });
    strictEqual(result.error?.code, 'ENOBUFS');
    strictEqual(result.stdout, '\u00e9'.repeat(700));
    strictEqual(result.status, null);
});

Deno.test('child_process: encoded string expansion does not exceed the byte limit', () => {
    for (const encoding of ['hex', 'base64'] as const) {
        const result = spawnSync(process.execPath, ['-e', 'process.stdout.write("x".repeat(700))'], {
            encoding, maxBuffer: 800,
        });
        strictEqual(result.error, undefined);
        strictEqual(result.status, 0);
        strictEqual(result.stdout, Buffer.alloc(700, 'x').toString(encoding));
    }
});

Deno.test('child_process: spawnSync truncates bytes before decoding a partial UTF-8 character', () => {
    const result = spawnSync(process.execPath, ['-e', 'process.stdout.write("\\u4e2d".repeat(30000))'], {
        encoding: 'utf8', maxBuffer: 1000,
    });
    strictEqual(result.error?.code, 'ENOBUFS');
    strictEqual(result.stdout, Buffer.from('\u4e2d'.repeat(30000)).subarray(0, 65536).toString('utf8'));
});

Deno.test('child_process: spawnSync shares its byte budget across stdout and stderr', () => {
    const result = spawnSync(process.execPath, ['-e',
        'process.stdout.write("a".repeat(700)); process.stderr.write("b".repeat(700))',
    ], { maxBuffer: 1000 });
    strictEqual(result.error?.code, 'ENOBUFS');
    strictEqual(result.stdout.length, 700);
    strictEqual(result.stderr.length, 700);
});

const largeOutputBytes = 18 * 65536;
const largeOutput = ['-e', `process.stdout.write("x".repeat(${largeOutputBytes}))`];

Deno.test('child_process: sync capture defaults to one MiB', () => {
    const result = spawnSync(process.execPath, largeOutput);
    strictEqual(result.error?.code, 'ENOBUFS');
    strictEqual(result.stdout.length, 17 * 65536);
    throws(() => execFileSync(process.execPath, largeOutput), { code: 'ENOBUFS' });
});

Deno.test('child_process: explicit unlimited sync capture options override the default', () => {
    for (const maxBuffer of [undefined, null, 0, Infinity]) {
        const result = spawnSync(process.execPath, largeOutput, { maxBuffer } as never);
        strictEqual(result.error, undefined, `maxBuffer=${String(maxBuffer)}`);
        strictEqual(result.status, 0);
        strictEqual(result.stdout.length, largeOutputBytes);
    }
});
