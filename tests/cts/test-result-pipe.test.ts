import { deepStrictEqual, ok, strictEqual } from 'node:assert';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { readTestChildResult } from '../../src/commands/test-result-pipe.ts';
import { withTempDir } from '../_helpers/temp.ts';

class FakePipe {
    onread: CModuleStreams.Stream['onread'] = () => {};
    started = false;
    stopped = false;
    closed = false;

    startRead(): void {
        this.started = true;
    }

    stopRead(): void {
        this.stopped = true;
    }

    close(): void {
        this.closed = true;
    }
}

Deno.test('test runner keeps Node IPC out of the CLI result path', () => {
    for (const path of ['../../src/commands/test.ts', '../../src/main.ts']) {
        const source = readFileSync(new URL(path, import.meta.url), 'utf8');
        ok(!source.includes('cno/src/node/ipc_channel'));
    }
});

Deno.test('test result pipe reassembles a split JSON frame and waits for EOF', async () => {
    const pipe = new FakePipe();
    const reader = readTestChildResult(pipe as unknown as CModuleStreams.Pipe);
    strictEqual(pipe.started, true);

    const expected = { passed: false, error: '\u2603', failedTests: [{ name: 'split frame' }] };
    const frame = new TextEncoder().encode(JSON.stringify(expected) + '\n');
    const utf8Start = frame.indexOf(0xe2);
    const split = utf8Start < 0 ? frame.length - 2 : utf8Start + 1;
    pipe.onread(frame.subarray(0, split), undefined);
    pipe.onread(frame.subarray(split), undefined);

    let settled = false;
    void reader.outcome.then(() => { settled = true; });
    await Promise.resolve();
    strictEqual(settled, false, 'the parent must leave fd3 open until the child finishes shutdown');

    pipe.onread(null, undefined);
    deepStrictEqual(await reader.outcome, { kind: 'result', message: expected });

    reader.close();
    ok(pipe.stopped);
    ok(pipe.closed);
});

Deno.test('test result pipe rejects non-object result frames', async () => {
    const pipe = new FakePipe();
    const reader = readTestChildResult(pipe as unknown as CModuleStreams.Pipe);
    pipe.onread(new TextEncoder().encode('["not a result"]\n'), undefined);

    const outcome = await reader.outcome;
    strictEqual(outcome.kind, 'error');
    if (outcome.kind === 'error') ok(String(outcome.error).includes('result must be a JSON object'));
    reader.close();
});

Deno.test({ name: 'test result pipe waits for a large child result write', timeout: 15000 }, async () => {
    await withTempDir('test-result-pipe', async (root) => {
        const file = join(root, 'large_failure.test.ts');
        await Deno.writeTextFile(file, `
            Deno.test('large diagnostic', () => {
                throw new Error('RESULT_PIPE_TAIL:' + 'x'.repeat(96 * 1024));
            });
        `);

        const output = await new Deno.Command(Deno.execPath(), {
            args: ['test', file, '--concurrency=1'],
            stdout: 'piped',
            stderr: 'piped',
        }).output();
        const text = new TextDecoder().decode(output.stdout) + new TextDecoder().decode(output.stderr);
        strictEqual(output.code, 1, text);
        ok(text.includes('RESULT_PIPE_TAIL:'), text);
        ok(!text.includes('without reporting a result'), text);
    });
});

Deno.test({ name: 'test runner preserves short runtime flags in its child execArgv', timeout: 15000 }, async () => {
    await withTempDir('test-result-pipe-argv', async (root) => {
        const file = join(root, 'conditions.test.ts');
        await Deno.writeTextFile(file, `
            import process from 'node:process';
            Deno.test('inherits short conditions flag', () => {
                const index = process.execArgv.indexOf('-C');
                if (index === -1 || process.execArgv[index + 1] !== 'test-condition') {
                    throw new Error('unexpected execArgv: ' + JSON.stringify(process.execArgv));
                }
            });
        `);

        const output = await new Deno.Command(Deno.execPath(), {
            args: ['test', '--concurrency=1', '-C', 'test-condition', file],
            stdout: 'piped',
            stderr: 'piped',
        }).output();
        const text = new TextDecoder().decode(output.stdout) + new TextDecoder().decode(output.stderr);
        strictEqual(output.code, 0, text);
    });
});
