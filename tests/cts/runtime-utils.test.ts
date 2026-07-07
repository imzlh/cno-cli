import { deepStrictEqual, ok, strictEqual } from 'node:assert';
import { Buffer } from 'node:buffer';
import setArgs, {
    buildDenoArgs,
    buildNodeArgv,
    buildNodeArgv0,
    buildNodeExecArgv,
    getArgs,
    parseArgs as parseRuntimeArgs,
} from '../../cno/src/utils/args.ts';
import {
    dirname,
    getExtension,
    join,
    normalize,
    systemPathSplit,
    toPosixPath,
} from '../../cno/src/utils/path.ts';
import { bridgeCjsToEsm } from '../../cts/src/compile/bridge.ts';
import { clearDirPathsCache, buildPaths } from '../../cts/src/compile/cjs.ts';
import { runAsync, runSync, StepType } from '../../cts/src/flow.ts';
import { withTempDir } from '../_helpers/temp.ts';

const engine = import.meta.use('engine');

type FlowGenerator<T> = Generator<{ type: StepType; [key: string]: unknown }, T, unknown>;

Deno.test('cno utils args: parseArgs separates internal action entry and script args', () => {
    deepStrictEqual(parseRuntimeArgs(['--inspect', 'run', '--reload', 'main.ts', '--user'], 'cno'), {
        binary: 'cno',
        internalArgs: ['--inspect'],
        action: 'run',
        actionArgs: ['--reload'],
        entry: 'main.ts',
        args: ['--user'],
    });

    deepStrictEqual(parseRuntimeArgs(['script.ts', '--flag'], 'cno'), {
        binary: 'cno',
        internalArgs: [],
        action: 'run',
        actionArgs: [],
        entry: 'script.ts',
        args: ['--flag'],
    });

    deepStrictEqual(parseRuntimeArgs([], 'cno'), {
        binary: 'cno',
        internalArgs: [],
        actionArgs: [],
        entry: 'repl',
        args: [],
    });
});

Deno.test('cno utils args: builders derive Deno and Node argv from shared state', () => {
    const original = getArgs();
    try {
        setArgs({
            binary: '/usr/bin/cno',
            internalArgs: ['--inspect=9229'],
            action: 'run',
            actionArgs: ['--reload'],
            entry: '/work/main.ts',
            args: ['--user', 'value'],
        });

        deepStrictEqual(buildDenoArgs(), ['--user', 'value']);
        deepStrictEqual(buildNodeArgv(), ['/usr/bin/cno', '/work/main.ts', '--user', 'value']);
        strictEqual(buildNodeArgv0(), '/usr/bin/cno');
        deepStrictEqual(buildNodeExecArgv(), ['--inspect=9229']);
    } finally {
        setArgs(original);
    }
});

Deno.test('cno utils path: normalize join dirname and extension cover common paths', () => {
    strictEqual(systemPathSplit, '/');
    strictEqual(toPosixPath('a\\b\\c'), 'a/b/c');
    strictEqual(normalize('/a/./b/../c'), '/a/c');
    strictEqual(normalize('a/../../b'), '../b');
    strictEqual(join('/tmp', 'a', '..', 'b'), '/tmp/b');
    strictEqual(dirname('/tmp/file.txt'), '/tmp');
    strictEqual(dirname('/file.txt'), '/');
    strictEqual(dirname('file.txt'), '.');
    strictEqual(getExtension('/tmp/archive.tar.gz'), '.gz');
    strictEqual(getExtension('/tmp/.env'), '.env');
});

Deno.test('cts flow: runSync executes filesystem steps and propagates caught errors', async () => {
    await withTempDir('runtime-utils', (root) => {
        const flowRoot = `${root}/flow`;
        function* flow(): FlowGenerator<string> {
            const exists = yield { type: StepType.FS_EXISTS, path: flowRoot };
            yield { type: StepType.FS_ENSURE_DIR, path: flowRoot };
            yield { type: StepType.FS_WRITE_TEXT, path: `${flowRoot}/sync.txt`, text: 'sync-data' };
            const text = yield { type: StepType.FS_READ_TEXT, path: `${flowRoot}/sync.txt` };
            return `${exists}:${text}`;
        }

        strictEqual(runSync(flow()), 'false:sync-data');

        function* catchesMissingRead(): FlowGenerator<boolean> {
            try {
                yield { type: StepType.FS_READ_TEXT, path: `${flowRoot}/missing.txt` };
            } catch (e) {
                return e instanceof Error;
            }
            return false;
        }

        strictEqual(runSync(catchesMissingRead()), true);
    });
});

Deno.test('cts flow: runAsync writes and reads bytes', async () => {
    await withTempDir('runtime-utils', async (root) => {
        function* flow(): FlowGenerator<number[]> {
            yield { type: StepType.FS_ENSURE_DIR, path: root };
            yield {
                type: StepType.FS_WRITE_BYTES,
                path: `${root}/async.bin`,
                data: Buffer.from([1, 2, 3, 4]),
            };
            const bytes = yield { type: StepType.FS_READ_BYTES, path: `${root}/async.bin` };
            return [...new Uint8Array(bytes as ArrayBuffer)];
        }

        deepStrictEqual(await runAsync(flow()), [1, 2, 3, 4]);
    });
});

Deno.test('cts cjs: buildPaths walks parent node_modules directories and caches', () => {
    clearDirPathsCache();
    const first = buildPaths('/a/b/c');
    deepStrictEqual(first, [
        '/a/b/c/node_modules',
        '/a/b/node_modules',
        '/a/node_modules',
    ]);
    strictEqual(buildPaths('/a/b/c'), first);
    clearDirPathsCache();
    ok(buildPaths('/a/b/c') !== first);
});

Deno.test('cts cjs bridge: exposes named exports attached to function exports', () => {
    function Ajv2020() {}
    Object.assign(Ajv2020, {
        Ajv2020,
        ValidationError: class ValidationError extends Error {},
    });

    const mod = bridgeCjsToEsm('/tmp/cjs-function-export.js', {}, Ajv2020);
    engine.promiseResult(mod.eval());
    strictEqual(mod.namespace.default, Ajv2020);
    strictEqual(mod.namespace.Ajv2020, Ajv2020);
    ok(typeof mod.namespace.ValidationError === 'function');
});
