import { deepStrictEqual, ok, strictEqual, throws } from 'node:assert';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { readTestChildResult } from '../../src/commands/test-result-pipe.ts';
import { collectTests, parseTestChildArgs } from '../../src/commands/test.ts';
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

Deno.test('test child argument protocol rejects malformed regions', () => {
    for (const data of ['1', '{}', '{', JSON.stringify({ version: 1, kernelArgs: [null], commandArgs: [] })]) {
        throws(() => parseTestChildArgs([], data), /Invalid test child argument protocol/);
    }
    throws(() => parseTestChildArgs([], JSON.stringify({
        version: 1, kernelArgs: ['run'], commandArgs: [],
    })), /Invalid test child argument regions/);
});

Deno.test('test discovery preserves extension scope and honors cno-host false markers', async () => {
    await withTempDir('test-host-marker', async (root) => {
        const skipped = join(root, 'node_only.test.ts');
        const discovered = join(root, 'portable.test.ts');
        const exactBoundary = join(root, 'exact_boundary.test.ts');
        const lateMarker = join(root, 'late_marker.test.ts');
        const markerWithSuffix = join(root, 'marker_suffix.test.ts');
        const newlineBoundary = join(root, 'newline_boundary.test.ts');
        const continuedBoundary = join(root, 'continued_boundary.test.ts');
        const explicitMjs = join(root, 'node_host.test.mjs');
        const marker = '// @cno-host: false';
        const boundaryPrefix = ' '.repeat(1024 - marker.length);
        await Deno.writeTextFile(skipped, '// @cno-host: false\nthrow new Error("node host only");\n');
        await Deno.writeTextFile(discovered, '// @cno-host: true\nDeno.test("portable", () => {});\n');
        await Deno.writeTextFile(exactBoundary, boundaryPrefix + marker);
        await Deno.writeTextFile(newlineBoundary, `${boundaryPrefix}${marker}\n`);
        await Deno.writeTextFile(lateMarker, `${' '.repeat(1024)}\n// @cno-host: false\n`);
        await Deno.writeTextFile(markerWithSuffix, '// @cno-host: false for now\n');
        await Deno.writeTextFile(continuedBoundary, `${boundaryPrefix}${marker} for now\n`);
        await Deno.writeTextFile(explicitMjs, 'throw new Error("explicit node host test");\n');

        deepStrictEqual(collectTests([root]), [continuedBoundary, lateMarker, markerWithSuffix, discovered]);
        deepStrictEqual(collectTests([skipped]), [skipped]);
        deepStrictEqual(collectTests([explicitMjs]), [explicitMjs]);
    });
});

Deno.test({ name: 'test runner preserves kernel and command regions in every child', timeout: 15000 }, async () => {
    await withTempDir('test-result-pipe-argv', async (root) => {
        const files = [join(root, 'first.test.ts'), join(root, 'second.test.ts')];
        const kernelArgs = ['-C', 'test-condition', '--conditions=second-condition'];
        const scriptArgs = ['--inspect', '--require', 'script-value', '--', ''];
        const source = `
            import process from 'node:process';
            import { deepStrictEqual } from 'node:assert';
            Deno.test('selected', () => {
                if (JSON.stringify(process.execArgv) !== ${JSON.stringify(JSON.stringify(kernelArgs))}) {
                    throw new Error('unexpected execArgv: ' + JSON.stringify(process.execArgv));
                }
                deepStrictEqual(Deno.args, ${JSON.stringify(scriptArgs)});
                deepStrictEqual(process.argv.slice(2), Deno.args);
            });
            Deno.test('excluded', () => { throw new Error('command filter was lost'); });
        `;
        for (const file of files) await Deno.writeTextFile(file, source);

        const output = await new Deno.Command(Deno.execPath(), {
            args: [
                ...kernelArgs, 'test', '--concurrency=2', '--filter=selected',
                '--inspect-wait=127.0.0.1:0', '--conditions=ignored',
                ...files, '--', ...scriptArgs,
            ],
            stdout: 'piped',
            stderr: 'piped',
            env: { NODE_OPTIONS: '', CNO_TEST_CHILD_TIMEOUT_MS: '5000' },
        }).output();
        const text = new TextDecoder().decode(output.stdout) + new TextDecoder().decode(output.stderr);
        strictEqual(output.code, 0, text);
        ok(text.includes('concurrency=2'), text);
        ok(!text.includes('Debugger listening'), text);
    });
});
