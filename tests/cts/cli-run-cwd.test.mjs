// @cno-host: false
// Exercise the current dispatcher without rebuilding the embedded CLI.
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { runInNewContext } from 'node:vm';
import { build } from 'esbuild';
import ts from 'typescript';

const repository = fileURLToPath(new URL('../../', import.meta.url));
const source = ts.createSourceFile('main.ts', fs.readFileSync(join(repository, 'src/main.ts'), 'utf8'),
    ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
const names = ['dispatch', 'looksLikeFileTarget', 'validateInvocation'];
const declarations = source.statements.filter(statement =>
    ts.isFunctionDeclaration(statement) && names.includes(statement.name?.text));
assert.equal(declarations.length, names.length);
const compiled = await build({
    stdin: {
        contents: `
            import { parseArgv, readArgv, unknownFlags, missingFlagValues } from './cli';
            import { cwd, isAbsolute, joinPaths, resolvePath, toPosixPath } from '../cts/src/utils/path';
            import { CliExit } from './command-error';
            const os = import.meta.use('os');
            const fs = import.meta.use('fs');
            ${declarations.map(statement => statement.getText(source)).join('\n')}
            export { dispatch };
        `,
        resolveDir: join(repository, 'src'), loader: 'ts',
    },
    bundle: true, write: false, format: 'cjs', platform: 'node',
    define: { 'import.meta.use': '__test_use__' },
    plugins: [{
        name: 'command-host',
        setup(plugin) {
            plugin.onResolve({ filter: /^\.\/commands\// }, ({ path }) => ({ path, namespace: 'command-host' }));
            plugin.onLoad({ filter: /./, namespace: 'command-host' }, () => ({
                contents: 'export const runTaskIfMatched = (...args) => __host__.runTaskIfMatched(...args);',
            }));
        },
    }],
});

function fixture(t, argv, { taskMatches = false } = {}) {
    const root = fs.mkdtempSync(join(tmpdir(), 'cno-run-cwd-dispatch-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const app = join(root, 'app');
    fs.mkdirSync(app);
    let currentDir = root;
    const calls = [];
    const native = {
        os: {
            args: ['cno', ...argv],
            platform: process.platform,
            guessHandle: () => 'file',
            getenv() { throw new Error('unset'); },
            get cwd() { return currentDir; },
            chdir(path) {
                const target = fs.realpathSync(resolve(currentDir, path));
                if (!fs.statSync(target).isDirectory()) throw new Error('not a directory');
                calls.push(['chdir', target]);
                currentDir = target;
            },
            uname: () => ({ sysname: process.platform === 'win32' ? 'Windows_NT' : 'Linux' }),
        },
        fs: { exists: path => fs.existsSync(resolve(currentDir, path)) },
        evbus: { get() {}, set() {} },
    };
    const module = { exports: {} };
    runInNewContext(compiled.outputFiles[0].text, {
        module, exports: module.exports, console,
        __test_use__: name => native[name],
        setArgs() {},
        prepareKernel: async () => { calls.push(['prepare', currentDir]); return {}; },
        effectiveRuntimeFlags: (_kernel, flags) => flags,
        applyNetworkFlags: async () => {},
        runEntry: async (entry, args, _flags, rawArgs) => {
            calls.push(['file', currentDir, entry, ...args]);
            assert.deepEqual(Array.from(rawArgs.scriptArgs), Array.from(args));
        },
        __host__: {
            runTaskIfMatched: async (name, _args, flags) => {
                calls.push(['task', currentDir, name, flags.cwd, flags.config]);
                return taskMatches;
            },
        },
    });
    return { root, app, calls, dispatch: module.exports.dispatch };
}

test('run --cwd switches directory after preparation and before file execution, preserving script arguments', async t => {
    const { root, app, calls, dispatch } = fixture(t,
        ['run', '--cwd', 'app', 'main.ts', '--cwd', 'script-value']);
    await dispatch();
    assert.deepEqual(calls, [
        ['prepare', root], ['chdir', app], ['file', app, 'main.ts', '--cwd', 'script-value'],
    ]);
});

test('run --cwd detects extensionless files in the execution directory before probing tasks', async t => {
    const { root, app, calls, dispatch } = fixture(t, ['run', '--cwd=app', 'probe'], { taskMatches: true });
    fs.writeFileSync(join(app, 'probe'), '');
    await dispatch();
    assert.deepEqual(calls, [['prepare', root], ['chdir', app], ['file', app, 'probe']]);
});

test('run --cwd task fallback preserves invocation cwd and relative config', async t => {
    const { root, calls, dispatch } = fixture(t,
        ['run', '--config=deno.json', '--cwd=app', 'probe'], { taskMatches: true });
    // An unrelated file in the invocation directory must not mask the task.
    fs.writeFileSync(join(root, 'probe'), '');
    await dispatch();
    assert.deepEqual(calls, [['prepare', root], ['task', root, 'probe', 'app', 'deno.json']]);
});

test('run --cwd executes a file after an unmatched task probe', async t => {
    const { root, app, calls, dispatch } = fixture(t, ['run', '--cwd=app', 'probe']);
    await dispatch();
    assert.deepEqual(calls, [
        ['prepare', root], ['task', root, 'probe', 'app', undefined], ['chdir', app], ['file', app, 'probe'],
    ]);
});

test('run without --cwd keeps the invocation directory', async t => {
    const { root, calls, dispatch } = fixture(t, ['run', 'main.ts']);
    await dispatch();
    assert.deepEqual(calls, [['prepare', root], ['file', root, 'main.ts']]);
});

test('run --cwd rejects missing and non-directory paths before file execution', async t => {
    for (const dir of ['missing', 'not-a-directory']) {
        const { root, calls, dispatch } = fixture(t, ['run', '--cwd', dir, 'main.ts']);
        fs.writeFileSync(join(root, 'not-a-directory'), '');
        await assert.rejects(dispatch());
        assert.deepEqual(calls, [['prepare', root]]);
    }
});
