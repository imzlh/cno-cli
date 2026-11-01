import { deepStrictEqual, ok, strictEqual, throws } from 'node:assert';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { readTestChildResult } from '../../src/commands/test-result-pipe.ts';
import { collectTests, parseTestChildArgs, shuffleFiles } from '../../src/commands/test.ts';
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

Deno.test('test discovery excludes repeated paths and glob patterns', async () => {
    await withTempDir('test-exclude', async (root) => {
        const originalCwd = Deno.cwd();
        const keep = join(root, 'keep.test.ts');
        const skipDir = join(root, 'skip');
        const skip = join(skipDir, 'throws.test.ts');
        const nestedDir = join(root, 'nested');
        const slow = join(nestedDir, 'slow_case.test.ts');
        const deepDir = join(nestedDir, 'deep');
        const deep = join(deepDir, 'slow_deep.test.ts');
        const similarDir = join(root, 'skipper');
        const similar = join(similarDir, 'kept.test.ts');
        await Deno.mkdir(skipDir);
        await Deno.mkdir(deepDir, { recursive: true });
        await Deno.mkdir(similarDir);
        for (const file of [keep, skip, slow, deep, similar]) {
            await Deno.writeTextFile(file, 'Deno.test("ok", () => {});\n');
        }

        try {
            Deno.chdir(root);
            deepStrictEqual(collectTests([root], ['skip', '**/slow*.test.ts']), [keep, similar]);
            deepStrictEqual(collectTests([skip], ['skip']), []);
            deepStrictEqual(collectTests([root], ['nested/*']), [keep, skip, similar]);
            deepStrictEqual(collectTests([root], ['**/deep/slow_????.test.ts']), [keep, slow, skip, similar]);
            deepStrictEqual(collectTests([root], [skip]), [keep, deep, slow, similar]);
            deepStrictEqual(collectTests([root], ['nested/slow**deep.test.ts']), [keep, deep, slow, skip, similar]);

            const alias = join(root, 'skip-alias');
            let linked = true;
            try {
                await Deno.symlink(skipDir, alias);
            } catch (error) {
                if (Deno.build.os === 'windows') linked = false;
                else throw error;
            }
            if (linked) {
                deepStrictEqual(collectTests([skipDir], [alias]), []);
                deepStrictEqual(collectTests([alias], [skipDir]), []);
            }

            const outside = join(root, '..', `${root.split(/[\\/]/).pop()}-outside`);
            await Deno.mkdir(outside);
            try {
                const outsideTest = join(outside, 'outside.test.ts');
                await Deno.writeTextFile(outsideTest, 'Deno.test("outside", () => {});\n');
                deepStrictEqual(collectTests([outside], [`../${outside.split(/[\\/]/).pop()}/*.test.ts`]), []);
            } finally {
                await Deno.remove(outside, { recursive: true });
            }
        } finally {
            Deno.chdir(originalCwd);
        }
    });
});

Deno.test({ name: 'test runner applies exclude aliases before spawning children', timeout: 15000 }, async () => {
    await withTempDir('test-exclude-runner', async (root) => {
        const keep = join(root, 'keep.test.ts');
        const skipDir = join(root, 'skip');
        const skip = join(skipDir, 'throws.test.ts');
        const nestedDir = join(root, 'nested');
        const slow = join(nestedDir, 'slow_case.test.ts');
        await Deno.mkdir(skipDir);
        await Deno.mkdir(nestedDir);
        await Deno.writeTextFile(keep, 'Deno.test("kept", () => {});\n');
        await Deno.writeTextFile(skip, 'throw new Error("EXCLUDED_DIRECTORY_RAN");\n');
        await Deno.writeTextFile(slow, 'throw new Error("EXCLUDED_GLOB_RAN");\n');

        const output = await new Deno.Command(Deno.execPath(), {
            args: ['test', '--concurrency=1', '--exclude=skip', '--ignore=**/slow*', root],
            cwd: root,
            stdout: 'piped',
            stderr: 'piped',
        }).output();
        const text = new TextDecoder().decode(output.stdout) + new TextDecoder().decode(output.stderr);
        strictEqual(output.code, 0, text);
        ok(text.includes('1/1'), text);
        ok(!text.includes('EXCLUDED_DIRECTORY_RAN'), text);
        ok(!text.includes('EXCLUDED_GLOB_RAN'), text);

        const comma = await new Deno.Command(Deno.execPath(), {
            args: ['test', '--concurrency=1', '--ignore=skip,**/slow*', root],
            cwd: root,
            stdout: 'piped',
            stderr: 'piped',
        }).output();
        const commaText = new TextDecoder().decode(comma.stdout) + new TextDecoder().decode(comma.stderr);
        strictEqual(comma.code, 0, commaText);
        ok(commaText.includes('1/1'), commaText);

        const empty = await new Deno.Command(Deno.execPath(), {
            args: ['test', '--permit-no-files', `--exclude=${keep}`, keep],
            stdout: 'piped',
            stderr: 'piped',
        }).output();
        const emptyText = new TextDecoder().decode(empty.stdout) + new TextDecoder().decode(empty.stderr);
        strictEqual(empty.code, 0, emptyText);
        ok(emptyText.includes('0/0'), emptyText);

        const rejectedEmpty = await new Deno.Command(Deno.execPath(), {
            args: ['test', `--exclude=${keep}`, keep],
            stdout: 'piped',
            stderr: 'piped',
        }).output();
        const rejectedText = new TextDecoder().decode(rejectedEmpty.stdout) + new TextDecoder().decode(rejectedEmpty.stderr);
        strictEqual(rejectedEmpty.code, 1, rejectedText);
        ok(rejectedText.includes('No test modules found'), rejectedText);
    });
});

Deno.test('test runner shuffle is deterministic per seed and preserves the file set', () => {
    const files = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'];
    deepStrictEqual(shuffleFiles(files, 42), shuffleFiles(files, 42));
    deepStrictEqual(shuffleFiles([], 1), []);
    deepStrictEqual(shuffleFiles(['only'], 1), ['only']);
    for (const seed of [0, 1, 42, 987654321]) {
        const shuffled = shuffleFiles(files, seed);
        deepStrictEqual([...shuffled].sort(), [...files].sort());
        ok(!shuffled.every((file, index) => file === files[index]), `seed ${seed} must move something`);
    }
    ok(shuffleFiles(files, 1).join(',') !== shuffleFiles(files, 2).join(','));
});

Deno.test({ name: 'test runner --no-run discovers files without executing them', timeout: 15000 }, async () => {
    await withTempDir('test-no-run', async (root) => {
        const good = join(root, 'good.test.ts');
        const bad = join(root, 'bad.test.ts');
        await Deno.writeTextFile(good, 'Deno.test("good", () => {});\n');
        await Deno.writeTextFile(bad, 'throw new Error("NO_RUN_STILL_LOADED");\n');

        const output = await new Deno.Command(Deno.execPath(), {
            args: ['test', '--no-run', root],
            cwd: root,
            stdout: 'piped',
            stderr: 'piped',
        }).output();
        const text = new TextDecoder().decode(output.stdout) + new TextDecoder().decode(output.stderr);
        strictEqual(output.code, 0, text);
        ok(text.includes('found 2 test modules'), text);
        ok(!text.includes('NO_RUN_STILL_LOADED'), text);

        // An empty set is still an error: --no-run proves discovery, not absence.
        const none = await new Deno.Command(Deno.execPath(), {
            args: ['test', '--no-run', join(root, 'missing')],
            cwd: root,
            stdout: 'piped',
            stderr: 'piped',
        }).output();
        const noneText = new TextDecoder().decode(none.stdout) + new TextDecoder().decode(none.stderr);
        strictEqual(none.code, 1, noneText);
        ok(noneText.includes('No test modules found'), noneText);
    });
});

Deno.test({ name: 'test runner --timeout kills a stalled worker ahead of the env fallback', timeout: 15000 }, async () => {
    await withTempDir('test-timeout', async (root) => {
        const stalled = join(root, 'stalled.test.ts');
        await Deno.writeTextFile(stalled, [
            'Deno.test("stalled", async () => {',
            '    await new Promise((resolve) => setTimeout(resolve, 10_000));',
            '});',
        ].join('\n'));

        // The flag must win over CNO_TEST_CHILD_TIMEOUT_MS, not lose to it.
        const output = await new Deno.Command(Deno.execPath(), {
            args: ['test', '--jobs=1', '--timeout=500', root],
            cwd: root,
            stdout: 'piped',
            stderr: 'piped',
            env: { CNO_TEST_CHILD_TIMEOUT_MS: '60000' },
        }).output();
        const text = new TextDecoder().decode(output.stdout) + new TextDecoder().decode(output.stderr);
        strictEqual(output.code, 1, text);
        ok(text.includes('timed out after 500ms'), text);

        const invalid = await new Deno.Command(Deno.execPath(), {
            args: ['test', '--timeout=abc', root],
            cwd: root,
            stdout: 'piped',
            stderr: 'piped',
        }).output();
        const invalidText = new TextDecoder().decode(invalid.stdout) + new TextDecoder().decode(invalid.stderr);
        strictEqual(invalid.code, 1, invalidText);
        ok(invalidText.includes('--timeout must be a positive integer'), invalidText);

        const bare = await new Deno.Command(Deno.execPath(), {
            args: ['test', '--timeout', root],
            cwd: root,
            stdout: 'piped',
            stderr: 'piped',
        }).output();
        const bareText = new TextDecoder().decode(bare.stdout) + new TextDecoder().decode(bare.stderr);
        strictEqual(bare.code, 1, bareText);
        ok(bareText.includes('--timeout must be a positive integer'), bareText);
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
