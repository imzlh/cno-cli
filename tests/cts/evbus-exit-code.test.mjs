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
        return found.get(name);
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

const sharedNames = ['REQUEST_EXIT_CODE_NAMESPACE', 'REQUEST_EXIT_CODE_KEY', 'REQUEST_EXIT_CODE_SLOT'];
const cliSource = await declarations('../../src/main.ts', [
    'requestedExitCode', ...sharedNames, 'currentProcessExitCode', 'syncExitCode', 'requestExitCode',
    'installRequestExitCodeHandler', 'TEST_CHILD_ENV_NAME', 'mainEntry',
]);
assert.ok(cliSource.includes("await import('./commands/test')"));
const cliScript = await script(cliSource.replace("await import('./commands/test')", 'await __test_import__()') + `
    globalThis.cli = { mainEntry, installRequestExitCodeHandler, requestExitCode, syncExitCode };
`);
const runtimeScript = await script(await declarations('../../cts/src/runtime/index.ts', [
    ...sharedNames, 'requestFailureExitCode',
]) + '\n globalThis.requestFailureExitCode = requestFailureExitCode;');

const slot = Symbol.for('cno.runtime.requestExitCode');
const namespace = 'cno.runtime';
const key = 'requestExitCode';
const readLegacy = context => new Script("globalThis[Symbol.for('cno.runtime.requestExitCode')]").runInContext(context);

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

function runtimeRealm(use, legacy) {
    const context = createContext({ __test_use__: use });
    if (legacy !== undefined) context[slot] = legacy;
    runtimeScript.runInContext(context);
    return context;
}

test('CLI exit requests cross realms through evbus, with legacy registration retained', async () => {
    const bus = createBus();
    const { context, calls } = cliRealm(bus);
    await context.cli.mainEntry();
    assert.equal(calls.dispatch, 1);
    assert.equal(typeof readLegacy(context), 'function');
    assert.equal(bus.get(namespace, key), readLegacy(context));

    const sandbox = runtimeRealm(() => bus);
    assert.equal(readLegacy(sandbox), undefined);
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
        runtimeRealm(() => bus).requestFailureExitCode();
        assert.deepEqual(calls.exitCodes, [code]);
        context.process.exitCode = 5;
        context.cli.syncExitCode();
        assert.equal(calls.exitCodes.at(-1), 5, 'a later explicit value wins');
    }
});

test('missing, invalid, or unreadable buses fall back to the realm-local handler', () => {
    for (const use of [
        () => null,
        () => { throw new Error('old host'); },
        () => ({ get: () => undefined }),
        () => ({ get: () => 'not a function' }),
        () => ({ get: () => { throw new Error('read failed'); } }),
    ]) {
        const codes = [];
        runtimeRealm(use, code => codes.push(code)).requestFailureExitCode();
        assert.deepEqual(codes, [1]);
    }

    // A host with no evbus, or one whose set fails, still supports old CTS.
    for (const bus of [null, { set: () => { throw new Error('write failed'); } }]) {
        const { context } = cliRealm(bus);
        const codes = [];
        context.cli.installRequestExitCodeHandler(code => codes.push(code));
        runtimeScript.runInContext(context);
        context.requestFailureExitCode();
        assert.deepEqual(codes, [1]);
    }

    const unreadable = runtimeRealm(() => null);
    Object.defineProperty(unreadable, slot, { get() { throw new Error('legacy read failed'); } });
    assert.doesNotThrow(() => unreadable.requestFailureExitCode());
});

test('a throwing evbus handler is never retried through the legacy slot', () => {
    for (const thrown of [new Error('handler failed'), undefined]) {
        let nativeCalls = 0;
        let legacyCalls = 0;
        const nativeHandler = () => { nativeCalls++; throw thrown; };
        const legacyHandler = () => { legacyCalls++; };
        const bus = { get: () => nativeHandler };
        const sandbox = runtimeRealm(() => bus, legacyHandler);
        assert.equal(readLegacy(sandbox), legacyHandler);
        assert.doesNotThrow(() => sandbox.requestFailureExitCode());
        assert.equal(nativeCalls, 1);
        assert.equal(legacyCalls, 0);
    }
});

test('test children install a no-op in both channels; workers install neither', async () => {
    const childBus = createBus();
    const child = cliRealm(childBus, { testInvocation: '1' });
    await child.context.cli.mainEntry();
    assert.equal(child.calls.testChild, 1);
    assert.equal(child.calls.dispatch, 0);
    assert.deepEqual(child.calls.unset, ['__CNO_TEST_CHILD']);
    assert.equal(childBus.get(namespace, key), readLegacy(child.context));
    runtimeRealm(() => childBus).requestFailureExitCode();
    assert.deepEqual(child.calls.exitCodes, []);

    const workerBus = createBus();
    const worker = cliRealm(workerBus, { isWorker: true });
    await worker.context.cli.mainEntry();
    assert.equal(worker.calls.worker, 1);
    assert.equal(worker.calls.dispatch, 0);
    assert.equal(workerBus.get(namespace, key), undefined);
    assert.equal(readLegacy(worker.context), undefined);
    assert.doesNotThrow(() => runtimeRealm(() => workerBus).requestFailureExitCode());
});
