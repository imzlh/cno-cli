import { deepStrictEqual, ok, rejects, strictEqual } from 'node:assert';
import { join } from 'node:path';
import { decodeUtf8 } from '../_helpers/bytes.ts';
import { withTempDir } from '../_helpers/temp.ts';

async function runEval(code: string): Promise<{ stdout: string; stderr: string; code: number }> {
    const output = await new Deno.Command(Deno.execPath(), {
        args: ['eval', code],
        stdout: 'piped',
        stderr: 'piped',
    }).output();
    return {
        stdout: decodeUtf8(output.stdout),
        stderr: decodeUtf8(output.stderr),
        code: output.code,
    };
}

function resultLine(stdout: string): any {
    const line = stdout.trim().split(/\r?\n/).findLast((value) => value.startsWith('RESULT '));
    ok(line, `missing RESULT line in stdout:\n${stdout}`);
    return JSON.parse(line.slice('RESULT '.length));
}

Deno.test({ name: 'deno test harness: hooks steps each and benches run in order', timeout: 10000 }, async () => {
    const child = await runEval(`
        const order = [];
        Deno.test.beforeAll(() => order.push('beforeAll'));
        Deno.test.beforeEach(() => order.push('beforeEach'));
        Deno.test.afterEach(() => order.push('afterEach'));
        Deno.test.afterAll(() => order.push('afterAll'));
        Deno.test.ignore('ignored child', () => order.push('ignored'));
        Deno.test.each([[1, 'a'], [2, 'b']])('case %d %s', (num, text, t) => {
            order.push('case:' + num + ':' + text + ':' + t.name);
        });
        Deno.test('steps child', async (t) => {
            order.push('test:' + t.name + ':' + t.origin);
            const passed = await t.step('inner step', (step) => {
                order.push('step:' + step.name + ':' + step.parent.name);
            });
            if (!passed) throw new Error('step did not pass');
        });
        Deno.bench('bench child', (b) => {
            b.start();
            order.push('bench');
            b.end();
        });
        const passed = await Deno.__startTest('harness-child.ts', 'both');
        console.log('RESULT ' + JSON.stringify({ passed, order }));
    `);

    strictEqual(child.code, 0, child.stderr);
    const result = resultLine(child.stdout);
    strictEqual(result.passed, true);
    deepStrictEqual(result.order, [
        'beforeAll',
        'beforeEach',
        'case:1:a:case 1 a',
        'afterEach',
        'beforeEach',
        'case:2:b:case 2 b',
        'afterEach',
        'beforeEach',
        'test:steps child:harness-child.ts',
        'step:inner step:steps child',
        'afterEach',
        'afterAll',
        'bench',
    ]);
});

Deno.test({ name: 'deno test harness: only filters ordinary tests', timeout: 10000 }, async () => {
    const child = await runEval(`
        const order = [];
        Deno.test('ordinary child', () => order.push('ordinary'));
        Deno.test.only('only child', () => order.push('only'));
        const passed = await Deno.__startTest('only-child.ts', 'test');
        console.log('RESULT ' + JSON.stringify({ passed, order }));
    `);

    strictEqual(child.code, 0, child.stderr);
    const result = resultLine(child.stdout);
    // specs/test/only: selected tests run, but overall suite fails when only is used
    strictEqual(result.passed, false);
    deepStrictEqual(result.order, ['only']);
});

Deno.test({ name: 'deno test harness: failing tests make __startTest return false', timeout: 10000 }, async () => {
    const child = await runEval(`
        Deno.test('failing child', () => {
            throw new Error('boom');
        });
        const passed = await Deno.__startTest('failure-child.ts', 'test');
        console.log('RESULT ' + JSON.stringify({ passed }));
    `);

    strictEqual(child.code, 0, child.stderr);
    const result = resultLine(child.stdout);
    strictEqual(result.passed, false);
    ok(child.stderr.includes('failing child'));
});

Deno.test({ name: 'deno test harness: noRun tests are registered but not executed', timeout: 10000 }, async () => {
    const child = await runEval(`
        const order = [];
        Deno.test({ name: 'type-only child', noRun: true, fn() {
            order.push('noRun executed');
            throw new Error('noRun should not execute');
        }});
        Deno.test('ordinary child', () => order.push('ordinary'));
        const passed = await Deno.__startTest('no-run-child.ts', 'test');
        console.log('RESULT ' + JSON.stringify({ passed, order }));
    `);

    strictEqual(child.code, 0, child.stderr);
    const result = resultLine(child.stdout);
    strictEqual(result.passed, true);
    deepStrictEqual(result.order, ['ordinary']);
});

Deno.test({ name: 'deno test harness: non-Error and AggregateError throws are collected', timeout: 10000 }, async () => {
    const child = await runEval(`
        Deno.test('undefined child', () => { throw undefined; });
        Deno.test('string child', () => { throw 'Hello, world!'; });
        Deno.test('aggregate child', () => {
            throw new AggregateError([new Error('Error 1'), new Error('Error 2')], 'Many');
        });
        const passed = await Deno.__startTest('throw-shapes-child.ts', 'test');
        console.log('RESULT ' + JSON.stringify({ passed }));
    `);

    strictEqual(child.code, 0, child.stderr);
    const result = resultLine(child.stdout);
    strictEqual(result.passed, false);
    ok(child.stderr.includes('undefined child'), child.stderr);
    ok(child.stderr.includes('undefined'), child.stderr);
    ok(child.stderr.includes('string child'), child.stderr);
    ok(child.stderr.includes('Hello, world!'), child.stderr);
    ok(child.stderr.includes('aggregate child'), child.stderr);
    ok(child.stderr.includes('AggregateError: Many'), child.stderr);
});

Deno.test({ name: 'deno test harness: failing hooks make __startTest return false', timeout: 10000 }, async () => {
    const child = await runEval(`
        const order = [];
        Deno.test.beforeAll(() => {
            order.push('beforeAll');
            throw new Error('beforeAll boom');
        });
        Deno.test.beforeEach(() => {
            order.push('beforeEach');
            throw new Error('beforeEach boom');
        });
        Deno.test.afterEach(() => {
            order.push('afterEach');
            throw new Error('afterEach boom');
        });
        Deno.test.afterAll(() => {
            order.push('afterAll');
            throw new Error('afterAll boom');
        });
        Deno.test('hook child', () => order.push('child'));
        const passed = await Deno.__startTest('hook-failure-child.ts', 'test');
        console.log('RESULT ' + JSON.stringify({ passed, order }));
    `);

    strictEqual(child.code, 0, child.stderr);
    const result = resultLine(child.stdout);
    strictEqual(result.passed, false);
    deepStrictEqual(result.order, ['beforeAll', 'beforeEach', 'child', 'afterEach', 'afterAll']);
    ok(child.stderr.includes('beforeAll hook failed'));
    ok(child.stderr.includes('beforeEach hook failed for hook child'));
    ok(child.stderr.includes('afterEach hook failed for hook child'));
    ok(child.stderr.includes('afterAll hook failed'));
});

Deno.test({ name: 'deno test harness: overloads ignore and each object cases', timeout: 10000 }, async () => {
    const child = await runEval(`
        const order = [];
        function namedChild(t) {
            order.push('function:' + t.name);
        }
        Deno.test(namedChild);
        Deno.test({ name: 'object/options child', ignore: false }, (t) => {
            order.push('object:' + t.name);
        });
        Deno.test('three arg ignored child', { ignore: true }, () => {
            order.push('should-not-run');
        });
        Deno.test('explicit undefined booleans', { ignore: undefined, only: undefined }, () => {
            order.push('explicit-undefined');
        });
        Deno.test.each([{ name: 'alice', count: 2 }, { name: 'bob', count: 3 }])('$name has $count', (item, t) => {
            order.push('each-object:' + t.name + ':' + item.count);
        });
        Deno.test.each(['scalar'])('scalar %s', (value, t) => {
            order.push('each-scalar:' + t.name + ':' + value);
        });
        const passed = await Deno.__startTest('overloads-child.ts', 'test');
        console.log('RESULT ' + JSON.stringify({ passed, order }));
    `);

    strictEqual(child.code, 0, child.stderr);
    const result = resultLine(child.stdout);
    strictEqual(result.passed, true);
    deepStrictEqual(result.order, [
        'function:namedChild',
        'object:object/options child',
        'explicit-undefined',
        'each-object:alice has 2:2',
        'each-object:bob has 3:3',
        'each-scalar:scalar scalar:scalar',
    ]);
});

Deno.test({ name: 'deno test harness: retry repeats timeout and failed steps are reflected', timeout: 10000 }, async () => {
    const child = await runEval(`
        const order = [];
        let retryAttempts = 0;
        Deno.test({
            name: 'retry child',
            retry: 2,
            fn() {
                retryAttempts++;
                order.push('retry:' + retryAttempts);
                if (retryAttempts < 2) throw new Error('try again');
            },
        });
        Deno.test({
            name: 'repeat child',
            repeats: 2,
            fn(t) {
                order.push('repeat:' + t.name);
            },
        });
        Deno.test('step result child', async (t) => {
            const ignored = await t.step({ name: 'ignored step', ignore: true, fn() {
                order.push('ignored-step-ran');
            }});
            order.push('ignored-step:' + ignored);
            const failed = await t.step('failing step', () => {
                throw new Error('step boom');
            });
            order.push('failed-step:' + failed);
        });
        Deno.test({ name: 'timeout child', timeout: 30, fn: () => new Promise(() => {}) });
        const passed = await Deno.__startTest('retry-repeat-child.ts', 'test');
        console.log('RESULT ' + JSON.stringify({ passed, order }));
    `);

    strictEqual(child.code, 0, child.stderr);
    const result = resultLine(child.stdout);
    strictEqual(result.passed, false);
    deepStrictEqual(result.order, [
        'retry:1',
        'retry:2',
        'repeat:repeat child (1/3)',
        'repeat:repeat child (2/3)',
        'repeat:repeat child (3/3)',
        'ignored-step:false',
        'failed-step:false',
    ]);
    ok(child.stderr.includes('failing step'));
    ok(child.stderr.includes('timeout child'));
});

Deno.test('deno test harness: TestContext.step rejects invalid step definitions', async (t) => {
    await rejects(() => t.step('missing function'), TypeError);
    await rejects(() => t.step('bad function', 'not a function' as unknown as () => void), TypeError);
    await rejects(() => t.step(undefined as unknown as Deno.TestStepDefinition), TypeError);
    await rejects(() => t.step(() => {}), TypeError);
    await rejects(() => t.step({ name: 'missing fn' } as Deno.TestStepDefinition), TypeError);
});

Deno.test({ name: 'deno test harness: invalid overloads and sanitizer no-op are observable', timeout: 10000 }, async () => {
    const child = await runEval(`
        const errors = [];
        for (const call of [
            () => Deno.test(),
            () => Deno.test('missing fn'),
            () => Deno.test({ name: 'missing object fn' }),
            () => Deno.test('', () => {}),
            () => Deno.test({ name: '', fn() {} }),
            () => Deno.test(() => {}),
            () => Deno.test(function named() {}, {}),
            () => Deno.test({ fn: () => {} }, function named() {}),
            () => Deno.test('named', { fn() {} }, () => {}),
            () => Deno.test('named', { name: 'other' }, () => {}),
            () => Deno.test({}),
            () => Deno.test({ fn: 'not a function' }),
            () => Deno.bench('missing bench fn'),
            () => Deno.bench({ name: 'missing bench object fn' }),
        ]) {
            try {
                call();
                errors.push('accepted');
            } catch (error) {
                errors.push(error instanceof TypeError ? error.message : String(error));
            }
        }
        const sanitizerResult = Deno.test.sanitizer();
        const order = [];
        Deno.test.ignore(function ignoredByFunction() {
            order.push('ignored-function');
        });
        const passed = await Deno.__startTest('invalid-overload-child.ts', 'test');
        console.log('RESULT ' + JSON.stringify({ passed, errors, sanitizerResult, order }));
    `);

    strictEqual(child.code, 0, child.stderr);
    const result = resultLine(child.stdout);
    strictEqual(result.passed, true);
    deepStrictEqual(result.errors, [
        'Invalid test definition',
        'Invalid test definition',
        "Expected 'fn' field in the first argument to be a test function",
        "The test name can't be empty",
        "The test name can't be empty",
        "The test function must have a name",
        "Unexpected second argument to Deno.test()",
        "Unexpected 'fn' field in options, test function is already provided as the second argument",
        "Unexpected 'fn' field in options, test function is already provided as the third argument",
        "Unexpected 'name' field in options, test name is already provided as the first argument",
        "Expected 'fn' field in the first argument to be a test function",
        "Expected 'fn' field in the first argument to be a test function",
        'Invalid bench definition',
        'Invalid bench definition',
    ]);
    strictEqual(result.sanitizerResult, undefined);
    deepStrictEqual(result.order, []);
});

Deno.test({ name: 'deno test harness: TestContext name origin and parent match upstream', timeout: 10000 }, async () => {
    const child = await runEval(`
        const contexts = [];
        Deno.test(async function namedContext(t1) {
            contexts.push({ name: t1.name, origin: t1.origin, parent: t1.parent === undefined });
            await t1.step('step', async (t2) => {
                contexts.push({ name: t2.name, origin: t2.origin, parent: t2.parent === t1 });
                await t2.step('nested step', (t3) => {
                    contexts.push({ name: t3.name, origin: t3.origin, parent: t3.parent === t2 });
                });
            });
        });
        const passed = await Deno.__startTest('context-origin-child.ts', 'test');
        console.log('RESULT ' + JSON.stringify({ passed, contexts }));
    `);

    strictEqual(child.code, 0, child.stderr);
    const result = resultLine(child.stdout);
    strictEqual(result.passed, true);
    deepStrictEqual(result.contexts, [
        { name: 'namedContext', origin: 'context-origin-child.ts', parent: true },
        { name: 'step', origin: 'context-origin-child.ts', parent: true },
        { name: 'nested step', origin: 'context-origin-child.ts', parent: true },
    ]);
});

Deno.test({ name: 'deno test harness: assertSnapshot creates matches and reports mismatches', timeout: 10000 }, async () => {
    const child = await runEval(`
        const result = [];
        Deno.test('snapshot child', async (t) => {
            const dir = Deno.makeTempDirSync({ prefix: 'cno-snapshot-' });
            try {
                await t.assertSnapshot({ value: 1 }, { dir, name: 'case' });
                await t.assertSnapshot({ value: 1 }, { dir, name: 'case' });
                try {
                    await t.assertSnapshot({ value: 2 }, { dir, name: 'case', msg: 'custom snapshot mismatch' });
                    result.push('accepted-mismatch');
                } catch (error) {
                    result.push(error.message);
                }
            } finally {
                Deno.removeSync(dir, { recursive: true });
            }
        });
        const passed = await Deno.__startTest('snapshot-child.ts', 'test');
        console.log('RESULT ' + JSON.stringify({ passed, result }));
    `);

    strictEqual(child.code, 0, child.stderr);
    const result = resultLine(child.stdout);
    strictEqual(result.passed, true);
    deepStrictEqual(result.result, ['custom snapshot mismatch']);
});

Deno.test({ name: 'deno bench harness: overload names ignore and only filters are reflected', timeout: 10000 }, async () => {
    const overloads = await runEval(`
        const order = [];
        function namedBench(b) {
            order.push('function:' + b.name);
        }
        Deno.bench(namedBench);
        Deno.bench({ name: 'object options bench', group: 'g' }, (b) => {
            order.push('object:' + b.name);
        });
        Deno.bench({ permissions: 'inherit' }, function inferredBench(b) {
            order.push('inferred:' + b.name);
        });
        Deno.bench('three arg ignored bench', { ignore: true }, () => {
            order.push('ignored-three-arg');
        });
        Deno.bench({ name: 'object ignored bench', ignore: true, fn() {
            order.push('ignored-object');
        }});
        const passed = await Deno.__startTest('bench-overloads-child.ts', 'bench');
        console.log('RESULT ' + JSON.stringify({ passed, order }));
    `);

    strictEqual(overloads.code, 0, overloads.stderr);
    const overloadResult = resultLine(overloads.stdout);
    strictEqual(overloadResult.passed, true);
    deepStrictEqual(overloadResult.order, [
        'function:namedBench',
        'object:object options bench',
        'inferred:inferredBench',
    ]);

    const only = await runEval(`
        const order = [];
        Deno.bench('ordinary bench', () => order.push('ordinary'));
        Deno.bench({ name: 'only bench', only: true, fn(b) {
            order.push('only:' + b.name);
        }});
        const passed = await Deno.__startTest('bench-only-child.ts', 'bench');
        console.log('RESULT ' + JSON.stringify({ passed, order }));
    `);

    strictEqual(only.code, 0, only.stderr);
    const onlyResult = resultLine(only.stdout);
    strictEqual(onlyResult.passed, true);
    deepStrictEqual(onlyResult.order, ['only:only bench']);
});

// specs/test/meta — Deno.test modules have import.meta.main === false
Deno.test({ name: 'deno test upstream: import.meta.main is false in tested modules', timeout: 15000 }, async () => {
    await withTempDir('deno-test-meta', async (root) => {
        const file = join(root, 'main.ts');
        await Deno.writeTextFile(file, `
const main = import.meta.main;
const url = import.meta.url;
Deno.test('check values', () => {
  if (main !== false) throw new Error('import.meta.main must be false under test, got ' + main);
  if (typeof url !== 'string' || !url.includes('main.ts')) throw new Error('bad url ' + url);
  console.log('import.meta.main: ' + main);
  console.log('import.meta.url: ' + url);
});
`);
        const output = await new Deno.Command(Deno.execPath(), {
            args: ['test', file, '--concurrency=1'],
            stdout: 'piped',
            stderr: 'piped',
        }).output();
        const text = new TextDecoder().decode(output.stdout) + new TextDecoder().decode(output.stderr);
        strictEqual(output.code, 0, text);
        ok(text.includes('import.meta.main: false'), text);
        ok(text.includes('main.ts'), text);
    });
});

// specs/test/clear_timeout — pending timers cleared before suite still run
Deno.test({ name: 'deno test upstream: clearTimeout of pending timer still runs suite', timeout: 15000 }, async () => {
    await withTempDir('deno-test-clear-timeout', async (root) => {
        const file = join(root, 'main.ts');
        await Deno.writeTextFile(file, `
clearTimeout(setTimeout(() => {}, 1000));
Deno.test('test 1', () => {});
Deno.test('test 2', () => {});
Deno.test('test 3', () => {});
`);
        const output = await new Deno.Command(Deno.execPath(), {
            args: ['test', file, '--concurrency=1'],
            stdout: 'piped',
            stderr: 'piped',
        }).output();
        const text = new TextDecoder().decode(output.stdout) + new TextDecoder().decode(output.stderr);
        strictEqual(output.code, 0, text);
        ok(/PASS|3\/|ok/i.test(text), text);
    });
});

// specs/test/exit_code, exit_code2, exit_code3
Deno.test({ name: 'deno test upstream: Deno.exitCode sanitizer fails tests and sticks', timeout: 20000 }, async () => {
    await withTempDir('deno-test-exit-code', async (root) => {
        const exit1 = join(root, 'exit1.js');
        await Deno.writeTextFile(exit1, `
Deno.test("Deno.exitCode", () => { Deno.exitCode = 42; });
`);
        const r1 = await new Deno.Command(Deno.execPath(), {
            args: ['test', exit1, '--concurrency=1'], stdout: 'piped', stderr: 'piped',
        }).output();
        const t1 = new TextDecoder().decode(r1.stdout) + new TextDecoder().decode(r1.stderr);
        strictEqual(r1.code, 1, t1);
        ok(/exit code set to 42|fail Deno\.exitCode/i.test(t1), t1);

        const exit2 = join(root, 'exit2.js');
        await Deno.writeTextFile(exit2, `
Deno.test("Deno.exitCode", () => { Deno.exitCode = 5; throw new Error(""); });
Deno.test("success", () => {});
`);
        const r2 = await new Deno.Command(Deno.execPath(), {
            args: ['test', exit2, '--concurrency=1'], stdout: 'piped', stderr: 'piped',
        }).output();
        const t2 = new TextDecoder().decode(r2.stdout) + new TextDecoder().decode(r2.stderr);
        strictEqual(r2.code, 1, t2);
        ok(/fail Deno\.exitCode/i.test(t2), t2);
        ok(/fail success|exit code set to 5/i.test(t2), t2);

        const exit3 = join(root, 'exit3.js');
        await Deno.writeTextFile(exit3, `
Deno.test("Deno.exitCode", () => { Deno.exitCode = 42; });
Deno.test("success", () => {});
`);
        const r3 = await new Deno.Command(Deno.execPath(), {
            args: ['test', exit3, '--concurrency=1'], stdout: 'piped', stderr: 'piped',
        }).output();
        const t3 = new TextDecoder().decode(r3.stdout) + new TextDecoder().decode(r3.stderr);
        strictEqual(r3.code, 1, t3);
        ok(/fail Deno\.exitCode|exit code set to 42/i.test(t3), t3);
        ok(/ok success/i.test(t3), t3);
    });
});

// specs/test/only — overall failure when only is used
Deno.test({ name: 'deno test upstream: only option fails overall run', timeout: 15000 }, async () => {
    await withTempDir('deno-test-only', async (root) => {
        const file = join(root, 'main.ts');
        await Deno.writeTextFile(file, `
Deno.test({ name: "before", fn() {} });
Deno.test({ only: true, name: "only", fn() {} });
Deno.test.only({ name: "only2", fn() {} });
Deno.test({ name: "after", fn() {} });
`);
        const output = await new Deno.Command(Deno.execPath(), {
            args: ['test', file, '--concurrency=1'], stdout: 'piped', stderr: 'piped',
        }).output();
        const text = new TextDecoder().decode(output.stdout) + new TextDecoder().decode(output.stderr);
        strictEqual(output.code, 1, text);
        ok(/ok only/i.test(text), text);
        ok(/ok only2/i.test(text), text);
        ok(!/ok before/i.test(text) && !/ok after/i.test(text), text);
    });
});

// specs/test/hooks — after* LIFO, before* FIFO
Deno.test({ name: 'deno test upstream: hooks order before FIFO after LIFO', timeout: 15000 }, async () => {
    const child = await runEval(`
        const logs = [];
        Deno.test.beforeAll(() => logs.push('beforeAll 1'));
        Deno.test.beforeAll(() => logs.push('beforeAll 2'));
        Deno.test.beforeEach(() => logs.push('beforeEach 1'));
        Deno.test.beforeEach(() => logs.push('beforeEach 2'));
        Deno.test.afterEach(() => logs.push('afterEach 1'));
        Deno.test.afterEach(() => logs.push('afterEach 2'));
        Deno.test.afterAll(() => logs.push('afterAll 1'));
        Deno.test.afterAll(() => logs.push('afterAll 2'));
        Deno.test('first', () => logs.push('test 1'));
        Deno.test('second', () => logs.push('test 2'));
        const passed = await Deno.__startTest('hooks-order.ts', 'test');
        console.log('RESULT ' + JSON.stringify({ passed, logs }));
    `);
    strictEqual(child.code, 0, child.stderr);
    const result = resultLine(child.stdout);
    // only option not used → but we didn't use only; hooks-only suite should pass
    // Wait: if no only, passed true. after LIFO means afterEach 2 before afterEach 1.
    deepStrictEqual(result.logs, [
        'beforeAll 1', 'beforeAll 2',
        'beforeEach 1', 'beforeEach 2', 'test 1', 'afterEach 2', 'afterEach 1',
        'beforeEach 1', 'beforeEach 2', 'test 2', 'afterEach 2', 'afterEach 1',
        'afterAll 2', 'afterAll 1',
    ]);
    strictEqual(result.passed, true);
});

// specs/test/load_unload
Deno.test({ name: 'deno test upstream: load before suite and unload after', timeout: 15000 }, async () => {
    await withTempDir('deno-test-load-unload', async (root) => {
        const file = join(root, 'main.ts');
        await Deno.writeTextFile(file, `
let interval = null;
addEventListener("load", () => {
  console.log("load");
  interval = setInterval(() => {}, 0);
});
addEventListener("unload", () => {
  console.log("unload");
  if (interval) clearInterval(interval);
});
Deno.test("test", () => {
  console.log("test");
  if (!interval) throw new Error("Interval was not set");
});
`);
        const output = await new Deno.Command(Deno.execPath(), {
            args: ['test', file, '--concurrency=1'], stdout: 'piped', stderr: 'piped',
        }).output();
        const text = new TextDecoder().decode(output.stdout) + new TextDecoder().decode(output.stderr);
        strictEqual(output.code, 0, text);
        const loadAt = text.indexOf('load');
        const testAt = text.indexOf('\ntest') >= 0 ? text.indexOf('\ntest') : text.indexOf('test');
        const unloadAt = text.indexOf('unload');
        ok(loadAt >= 0 && testAt > loadAt, text);
        ok(unloadAt > testAt, text);
    });
});

// specs/test/report_error
Deno.test({ name: 'deno test upstream: reportError fails the suite', timeout: 15000 }, async () => {
    await withTempDir('deno-test-report-error', async (root) => {
        const file = join(root, 'main.ts');
        await Deno.writeTextFile(file, `
Deno.test("foo", () => {
  reportError(new Error("foo"));
  console.log(1);
});
Deno.test("bar", () => {});
`);
        const output = await new Deno.Command(Deno.execPath(), {
            args: ['test', file, '--concurrency=1'], stdout: 'piped', stderr: 'piped',
        }).output();
        const text = new TextDecoder().decode(output.stdout) + new TextDecoder().decode(output.stderr);
        strictEqual(output.code, 1, text);
        ok(/fail|FAILED|error/i.test(text), text);
    });
});

// specs/test/finally_timeout, ignore, interval
Deno.test({ name: 'deno test upstream: finally clearTimeout ignore and empty interval file', timeout: 20000 }, async () => {
    await withTempDir('deno-test-misc', async (root) => {
        const finallyFile = join(root, 'finally.ts');
        await Deno.writeTextFile(finallyFile, `
Deno.test("error", function () {
  const timer = setTimeout(() => null, 10000);
  try { throw new Error("fail"); } finally { clearTimeout(timer); }
});
Deno.test("success", function () {});
`);
        const r1 = await new Deno.Command(Deno.execPath(), {
            args: ['test', finallyFile, '--concurrency=1'], stdout: 'piped', stderr: 'piped',
        }).output();
        const t1 = new TextDecoder().decode(r1.stdout) + new TextDecoder().decode(r1.stderr);
        strictEqual(r1.code, 1, t1);
        ok(/fail error|Error: fail/i.test(t1), t1);
        ok(/ok success/i.test(t1), t1);

        const ignoreFile = join(root, 'ignore.ts');
        await Deno.writeTextFile(ignoreFile, `
for (let i = 0; i < 3; i++) {
  Deno.test({ name: "test " + i, ignore: true, fn() { throw new Error("unreachable"); } });
}
Deno.test.ignore({ name: "test ignore", fn() { throw new Error("unreachable"); } });
`);
        const r2 = await new Deno.Command(Deno.execPath(), {
            args: ['test', ignoreFile, '--concurrency=1'], stdout: 'piped', stderr: 'piped',
        }).output();
        const t2 = new TextDecoder().decode(r2.stdout) + new TextDecoder().decode(r2.stderr);
        strictEqual(r2.code, 0, t2);
        ok(/skip|ignored|PASS/i.test(t2), t2);

        const intervalFile = join(root, 'interval.ts');
        await Deno.writeTextFile(intervalFile, `setInterval(function () {}, 0);`);
        const r3 = await new Deno.Command(Deno.execPath(), {
            args: ['test', intervalFile, '--concurrency=1'], stdout: 'piped', stderr: 'piped',
        }).output();
        const t3 = new TextDecoder().decode(r3.stdout) + new TextDecoder().decode(r3.stderr);
        strictEqual(r3.code, 0, t3);
    });
});
