// @cno-host: false
// Run with: node --test tests/cts/evbus-exit-code.test.mjs
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { createContext, Script } from 'node:vm';
import { transform } from 'esbuild';
import ts from 'typescript';

// Exercise the production declarations in isolated realms without booting the
// entire CLI or polluting its non-configurable runtime globals.
async function declarations(path, names) {
    const text = await readFile(new URL(path, import.meta.url), 'utf8');
    const source = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
    const found = new Map();
    for (const node of source.statements) {
        if (ts.isFunctionDeclaration(node) && node.name) found.set(node.name.text, node.getText(source));
        if (ts.isVariableStatement(node)) {
            for (const decl of node.declarationList.declarations) {
                if (ts.isIdentifier(decl.name)) found.set(decl.name.text, node.getText(source));
            }
        }
    }
    return names.map(name => {
        assert.ok(found.has(name), `missing ${name} in ${path}`);
        // Extracted bodies are re-wrapped in an IIFE, so exported declarations
        // lose their `export` modifier.
        return found.get(name).replace(/^export\s+/, '');
    }).join('\n');
}

async function script(source) {
    const result = await transform(`(() => {\n${source}\n})()`, {
        loader: 'ts',
        target: 'es2022',
        define: { 'import.meta.use': '__test_use__' },
    });
    return new Script(result.code);
}

const channelNames = ['evbus', 'RUNTIME_CHANNEL_NAMESPACE', 'CHANNEL_REQUEST_EXIT_CODE', 'publishChannel', 'readChannel'];
const cliSource = await declarations('../../src/channels.ts', channelNames) + '\n' + await declarations('../../src/main.ts', [
    'requestedExitCode', 'currentProcessExitCode', 'syncExitCode', 'requestExitCode',
    'installRequestExitCodeHandler', 'TEST_CHILD_ENV_NAME', 'mainEntry',
]);
assert.ok(cliSource.includes("await import('./commands/test')"));
const cliScript = await script(cliSource.replace("await import('./commands/test')", 'await __test_import__()') + `
    globalThis.cli = { mainEntry, installRequestExitCodeHandler, requestExitCode, syncExitCode };
`);
const runtimeScript = await script(await declarations('../../cts/src/runtime/index.ts', [
    'REQUEST_EXIT_CODE_NAMESPACE', 'REQUEST_EXIT_CODE_KEY', 'requestFailureExitCode',
]) + '\n globalThis.requestFailureExitCode = requestFailureExitCode;');

const namespace = 'cno.runtime';
const key = 'requestExitCode';

function createBus() {
    const values = new Map();
    const id = (ns, name) => JSON.stringify([ns, name]);
    return {
        get: (ns, name) => values.get(id(ns, name)),
        set: (ns, name, value) => values.set(id(ns, name), value),
    };
}

function cliRealm(bus, { isWorker = false, testInvocation = null } = {}) {
    const calls = { exitCodes: [], unset: [], dispatch: 0, worker: 0, testChild: 0 };
    const context = createContext({
        __test_use__: () => bus,
        __test_import__: async () => ({
            parseTestChildArgs: () => ({ cli: 'parsed', scriptArgs: ['arg'] }),
        }),
        os: {
            args: ['cno', 'fixture.ts', 'arg'],
            setExitCode: code => calls.exitCodes.push(code),
            unsetenv: name => calls.unset.push(name),
        },
        process: {},
        worker: { isWorker },
        readEnv: () => testInvocation,
        workerEntry: async () => { calls.worker++; },
        runTestChild: async (file, cli, args) => {
            assert.equal(file, 'fixture.ts');
            assert.equal(cli, 'parsed');
            assert.deepEqual(args, ['arg']);
            calls.testChild++;
        },
        dispatch: async () => { calls.dispatch++; },
    });
    cliScript.runInContext(context);
    return { context, calls };
}

function runtimeRealm(use, bus) {
    const context = createContext({ __test_use__: use ?? (() => bus) });
    runtimeScript.runInContext(context);
    return context;
}

test('CLI exit requests cross realms through evbus', async () => {
    const bus = createBus();
    const { context, calls } = cliRealm(bus);
    await context.cli.mainEntry();
    assert.equal(calls.dispatch, 1);
    assert.equal(typeof bus.get(namespace, key), 'function', 'the CLI published its handler');

    const sandbox = runtimeRealm(null, bus);
    sandbox.requestFailureExitCode();
    sandbox.requestFailureExitCode();
    assert.deepEqual(calls.exitCodes, [1], 'the first failure request sets the status once');
});

test('explicit process exit codes, including zero, retain precedence', () => {
    for (const code of [7, 0]) {
        const bus = createBus();
        const { context, calls } = cliRealm(bus);
        context.process.exitCode = code;
        context.cli.installRequestExitCodeHandler(context.cli.requestExitCode);
        runtimeRealm(null, bus).requestFailureExitCode();
        assert.deepEqual(calls.exitCodes, [code]);
        context.process.exitCode = 5;
        context.cli.syncExitCode();
        assert.equal(calls.exitCodes.at(-1), 5, 'a later explicit value wins');
    }
});

test('a missing, invalid, or unreadable bus disables the failure request', () => {
    for (const use of [
        () => null,
        () => { throw new Error('broken host'); },
        () => ({}),
        () => ({ get: () => undefined }),
        () => ({ get: () => 'not a function' }),
        () => ({ get: () => { throw new Error('read failed'); } }),
    ]) {
        const codes = [];
        runtimeRealm(use, undefined).requestFailureExitCode();
        assert.deepEqual(codes, [], 'no legacy fallback exists');
        void codes;
    }
});

test('a throwing evbus handler fails the request, never the runtime', () => {
    for (const thrown of [new Error('handler failed'), undefined]) {
        let calls = 0;
        const bus = { get: () => () => { calls++; throw thrown; } };
        const sandbox = runtimeRealm(() => bus, undefined);
        assert.doesNotThrow(() => sandbox.requestFailureExitCode());
        assert.equal(calls, 1, 'the handler ran exactly once');
    }
});

test('test children install a no-op; workers install neither', async () => {
    const childBus = createBus();
    const child = cliRealm(childBus, { testInvocation: '1' });
    await child.context.cli.mainEntry();
    assert.equal(child.calls.testChild, 1);
    assert.equal(child.calls.dispatch, 0);
    assert.deepEqual(child.calls.unset, ['__CNO_TEST_CHILD']);
    assert.equal(typeof childBus.get(namespace, key), 'function', 'a no-op is published');
    runtimeRealm(null, childBus).requestFailureExitCode();
    assert.deepEqual(child.calls.exitCodes, [], 'the suite owns the exit status');

    const workerBus = createBus();
    const worker = cliRealm(workerBus, { isWorker: true });
    await worker.context.cli.mainEntry();
    assert.equal(worker.calls.worker, 1);
    assert.equal(worker.calls.dispatch, 0);
    assert.equal(workerBus.get(namespace, key), undefined);
    assert.doesNotThrow(() => runtimeRealm(null, workerBus).requestFailureExitCode());
});
