import { deepStrictEqual, ok, rejects, strictEqual, throws } from 'node:assert';
import { Buffer } from 'node:buffer';
import setArgs, {
    buildDenoArgs,
    buildNodeArgv,
    buildNodeArgv0,
    buildNodeExecArgv,
    getArgs,
    normalizeArgs,
    parseArgs as parseRuntimeArgs,
} from '../../cno/src/utils/args.ts';
import {
    basename,
    dirname,
    getExtension,
    isPathWithin,
    join,
    normalize,
    pathParents,
    resolvePath,
    systemPathSplit,
    toSystemPath,
    toFsPath,
    toPosixPath,
} from '../../cno/src/utils/path.ts';
import { isPosixCompatible } from '../../cno/src/utils/platform.ts';
import { bridgeCjsToEsm } from '../../cts/src/compile/bridge.ts';
import { clearDirPathsCache, buildPaths } from '../../cts/src/compile/cjs.ts';
import { runAsync, runSync, StepType } from '../../cts/src/flow.ts';
import { ensureDir, ensureDirAsync } from '../../cts/src/utils/io.ts';
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

Deno.test('cno utils args: normalized names share storage and cannot drift', () => {
    const original = getArgs();
    try {
        const normalized = normalizeArgs({
            binary: 'cno', internalArgs: ['--inspect'], actionArgs: ['--reload'],
            action: 'run', entry: '/work/main.ts', args: ['original'],
        });
        strictEqual(normalized.kernelArgs, normalized.internalArgs);
        strictEqual(normalized.commandArgs, normalized.actionArgs);
        strictEqual(normalized.scriptArgs, normalized.args);
        normalized.kernelArgs = ['--conditions=development'];
        normalized.args = ['--inspect', '--require', 'script'];
        setArgs(normalized);
        deepStrictEqual(buildNodeExecArgv(), ['--conditions=development']);
        deepStrictEqual(buildDenoArgs(), ['--inspect', '--require', 'script']);
        deepStrictEqual(buildNodeArgv(), ['cno', '/work/main.ts', '--inspect', '--require', 'script']);
        const snapshot = buildDenoArgs();
        snapshot.push('local-only');
        deepStrictEqual(buildDenoArgs(), ['--inspect', '--require', 'script']);
    } finally { setArgs(original); }
});

Deno.test('cno utils args: fallback honors option terminators and stdin entries', () => {
    const implicit = parseRuntimeArgs(['--', '--entry.ts', '--user'], 'cno');
    strictEqual(implicit.entry, '--entry.ts');
    deepStrictEqual(implicit.kernelArgs, []);
    deepStrictEqual(implicit.scriptArgs, ['--user']);
    const explicit = parseRuntimeArgs(['run', '--', '--entry.ts', '--', '--user'], 'cno');
    strictEqual(explicit.entry, '--entry.ts');
    deepStrictEqual(explicit.commandArgs, []);
    deepStrictEqual(explicit.scriptArgs, ['--', '--user']);
    strictEqual(parseRuntimeArgs(['run', '-', 'user'], 'cno').entry, '-');
});

Deno.test('cno utils args: Windows drive-relative entries use the drive-aware resolver', () => {
    if (isPosixCompatible) return;
    const original = getArgs();
    try {
        setArgs({
            binary: 'cno.exe',
            internalArgs: [],
            action: 'run',
            actionArgs: [],
            entry: 'C:entry.js',
            args: [],
        });
        strictEqual(buildNodeArgv()[1], resolvePath('C:entry.js', import.meta.use('os').cwd));
    } finally {
        setArgs(original);
    }
});

Deno.test('cno utils args: eval metadata preserves exact Node execArgv spelling', () => {
    const original = getArgs();
    try {
        setArgs({
            binary: '/usr/bin/cno',
            internalArgs: ['--no-warnings'],
            action: 'eval',
            actionArgs: [],
            entry: 'console.log(1)',
            args: ['user'],
            evalToken: { flag: '-p', inline: false },
        });
        deepStrictEqual(buildDenoArgs(), ['user']);
        deepStrictEqual(buildNodeArgv(), ['/usr/bin/cno', 'user']);
        strictEqual(buildNodeArgv0(), '/usr/bin/cno');
        deepStrictEqual(buildNodeExecArgv(), ['--no-warnings', '-p', 'console.log(1)']);

        setArgs({
            binary: '/usr/bin/cno',
            internalArgs: [],
            action: 'eval',
            actionArgs: [],
            entry: '',
            args: [],
            evalToken: { flag: '--eval', inline: true },
        });
        deepStrictEqual(buildNodeExecArgv(), ['--eval=']);

        setArgs({
            binary: '/usr/bin/cno',
            internalArgs: [],
            action: 'eval',
            actionArgs: [],
            entry: '42',
            args: [],
        });
        deepStrictEqual(buildNodeExecArgv(), ['-e', '42']);
    } finally {
        setArgs(original);
    }
});

// cno/src/utils/path.ts is the NATIVE path layer (systemPathSplit is
// `isPosixCompatible ? '/' : '\\'`), distinct from cts/src/utils/path.ts which is
// the POSIX-internal layer. Asserting '/' here was a TEST BUG: it hardcoded the
// POSIX branch of a deliberately platform-dependent constant, so it could only
// ever pass on POSIX. Measured on Windows 11 (cno run):
//   systemPathSplit -> "\\"   normalize('C:/a/./b/../c') -> "C:\\a\\c"
//   join('C:/tmp','a','..','b') -> "C:\\tmp\\b"
// dirname()/getExtension() are separator-agnostic (they scan for both / and \),
// so those expectations are platform-independent and unchanged.
Deno.test('cno utils path: normalize join dirname and extension cover common paths', () => {
    strictEqual(systemPathSplit, isPosixCompatible ? '/' : '\\');
    strictEqual(toPosixPath('a\\b\\c'), 'a/b/c');
    // Use a drive-absolute path on Windows: a driveless rooted path hits a
    // separate known bug (see the root-preservation test below).
    strictEqual(
        normalize(isPosixCompatible ? '/a/./b/../c' : 'C:/a/./b/../c'),
        isPosixCompatible ? '/a/c' : 'C:\\a\\c',
    );
    strictEqual(normalize('a/../../b'), isPosixCompatible ? '../b' : '..\\b');
    strictEqual(normalize('a/../'), isPosixCompatible ? './' : '.\\');
    strictEqual(normalize('./'), isPosixCompatible ? './' : '.\\');
    strictEqual(
        join(isPosixCompatible ? '/tmp' : 'C:/tmp', 'a', '..', 'b'),
        isPosixCompatible ? '/tmp/b' : 'C:\\tmp\\b',
    );
    strictEqual(dirname('/tmp/file.txt'), '/tmp');
    strictEqual(dirname('/file.txt'), isPosixCompatible ? '/' : '\\');
    strictEqual(dirname('file.txt'), '.');
    strictEqual(getExtension('/tmp/archive.tar.gz'), '.gz');
    strictEqual(getExtension('/tmp/.env'), '.env');
});

Deno.test('cno utils path: normalize preserves driveless rooted paths', () => {
    strictEqual(normalize('/a/b'), isPosixCompatible ? '/a/b' : '\\a\\b');
    strictEqual(normalize('/'), isPosixCompatible ? '/' : '\\');
});

Deno.test('cno utils path: normalize preserves drive and share roots after dot segments', () => {
    if (isPosixCompatible) return;

    strictEqual(normalize('C:/dir/..'), 'C:\\');
    strictEqual(normalize('C:/dir/../'), 'C:\\');
    strictEqual(normalize('\\\\server\\share\\dir\\..'), '\\\\server\\share\\');
    strictEqual(normalize('\\\\?\\C:\\dir\\..'), '\\\\?\\C:\\');
    strictEqual(normalize('\\\\?\\UNC\\server\\share\\dir\\..'), '\\\\?\\UNC\\server\\share\\');
});

Deno.test('cno utils path: recursive parents preserve UNC and verbatim roots', () => {
    if (isPosixCompatible) return;

    deepStrictEqual([...pathParents('\\\\server\\share\\a\\b')], [
        '\\\\server\\share\\a',
        '\\\\server\\share\\a\\b',
    ]);
    deepStrictEqual([...pathParents('\\\\?\\C:\\a\\b')], [
        '\\\\?\\C:\\a',
        '\\\\?\\C:\\a\\b',
    ]);
    deepStrictEqual([...pathParents('\\\\?\\UNC\\server\\share\\a\\b')], [
        '\\\\?\\UNC\\server\\share\\a',
        '\\\\?\\UNC\\server\\share\\a\\b',
    ]);
});

Deno.test('cno utils path: Windows dirname and basename preserve root contracts', () => {
    if (isPosixCompatible) return;

    strictEqual(dirname('C:'), 'C:');
    strictEqual(dirname('C:foo'), 'C:');
    strictEqual(dirname('C:\\foo'), 'C:\\');
    strictEqual(dirname('\\\\server\\share'), '\\\\server\\share');
    strictEqual(dirname('\\\\server\\share\\a'), '\\\\server\\share\\');
    strictEqual(dirname('\\\\?\\C:\\a'), '\\\\?\\C:\\');
    strictEqual(dirname('\\\\?\\UNC\\server\\share\\a'), '\\\\?\\UNC\\server\\share');

    strictEqual(basename('C:'), '');
    strictEqual(basename('C:foo'), 'foo');
    strictEqual(basename('C:\\foo'), 'foo');
    strictEqual(basename('\\\\server\\share'), 'share');
    strictEqual(basename('\\\\server\\share\\a'), 'a');
});

Deno.test('cno utils path: rooted resolution keeps the cwd share root', () => {
    if (isPosixCompatible) return;

    strictEqual(resolvePath('\\child', '\\\\server\\share\\work'), '\\\\server\\share\\child');
    strictEqual(resolvePath('\\child', '\\\\?\\UNC\\server\\share\\work'), '\\\\?\\UNC\\server\\share\\child');
});

Deno.test('cno utils path: URL decoding and parent paths preserve native boundaries', () => {
    strictEqual(toFsPath(new URL('file:///tmp/a%20b')), isPosixCompatible ? '/tmp/a b' : '\\tmp\\a b');
    if (!isPosixCompatible) {
        // The URL parser canonicalizes legacy file://C:/... input to the
        // standard file:///C:/... form before the shared converter sees it.
        strictEqual(toFsPath(new URL('file://C:/tmp/a%20b')), 'C:\\tmp\\a b');
    }
    strictEqual(toFsPath(new URL('file:///tmp/a%2Fb')), isPosixCompatible ? '/tmp/a/b' : '\\tmp\\a/b');
    strictEqual(toFsPath(new URL('file:///tmp/a%5Cb')), isPosixCompatible ? '/tmp/a\\b' : '\\tmp\\a\\b');

    const parents = [...pathParents(isPosixCompatible ? '/a/b/c' : 'C:/a/b/c')];
    deepStrictEqual(parents, isPosixCompatible ? ['/a', '/a/b', '/a/b/c'] : ['C:\\a', 'C:\\a\\b', 'C:\\a\\b\\c']);
});

Deno.test('cno utils path: malformed file URL escapes keep Deno error semantics', () => {
    strictEqual(toFsPath(new URL('file:///tmp/%zz')).endsWith('%zz'), true);
    throws(() => toFsPath(new URL('file:///tmp/%E0%A4%A')), URIError);
    strictEqual(toSystemPath('a/b'), isPosixCompatible ? 'a/b' : 'a\\b');
    strictEqual(toSystemPath('a\\b'), 'a\\b');
});

Deno.test('cno utils path: resolve and containment handle Windows path classes', () => {
    if (isPosixCompatible) {
        strictEqual(resolvePath('child/file', '/work'), '/work/child/file');
        strictEqual(isPathWithin('/work', '/work/child'), true);
        strictEqual(isPathWithin('/work/', '/work/child'), true);
        strictEqual(isPathWithin('/work', '/workspace'), false);
        return;
    }

    strictEqual(resolvePath('child\\file', 'C:\\work'), 'C:\\work\\child\\file');
    strictEqual(resolvePath('\\child\\file', 'C:\\work'), 'C:\\child\\file');
    strictEqual(resolvePath('//server/share/child/file', 'C:\\work'), '\\\\server\\share\\child\\file');
    strictEqual(resolvePath('//?/UNC/server/share/child/file', 'C:\\work'), '\\\\?\\UNC\\server\\share\\child\\file');
    strictEqual(resolvePath('D:child', 'C:\\work'), 'D:\\child');
    strictEqual(isPathWithin('C:\\work', 'c:/WORK/child'), true);
    strictEqual(isPathWithin('C:\\work', 'C:\\workspace'), false);
});

Deno.test('cno utils path: recursive parents never yield filesystem roots', () => {
    if (isPosixCompatible) return;

    deepStrictEqual([...pathParents('C:\\')], []);
    deepStrictEqual([...pathParents('\\\\server\\share')], []);
    deepStrictEqual([...pathParents('\\\\?\\C:\\')], []);
    deepStrictEqual([...pathParents('\\\\?\\UNC\\server\\share')], []);
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

Deno.test('cts io: recursive directory creation rejects a same-named file', async () => {
    await withTempDir('runtime-utils-file-dir', async (root) => {
        const occupied = `${root}/occupied`;
        Deno.writeTextFileSync(occupied, 'file');

        throws(() => ensureDir(occupied), /Failed to create directory/);
        await rejects(() => ensureDirAsync(occupied), /Failed to create directory/);
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
