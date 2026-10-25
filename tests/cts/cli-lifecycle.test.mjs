// Run with: node --test tests/cts/cli-lifecycle.test.mjs
import assert from 'node:assert/strict';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { runInNewContext } from 'node:vm';
import { build } from 'esbuild';

const repository = fileURLToPath(new URL('../../', import.meta.url));
const sources = new Map();

async function compile(entry) {
    if (!sources.has(entry)) {
        sources.set(entry, build({
            absWorkingDir: repository,
            entryPoints: [entry], bundle: true, write: false, format: 'cjs', platform: 'node',
            define: { 'import.meta.use': '__test_use__' },
            plugins: [{
                name: 'inspector-host',
                setup(plugin) {
                    plugin.onResolve({ filter: /^\.\/main\/inspector$/ }, () => ({ path: 'inspector', namespace: 'fixture' }));
                    plugin.onLoad({ filter: /./, namespace: 'fixture' }, () => ({
                        contents: 'export const Inspector = __test_inspector__;',
                    }));
                },
            }],
        }).then(result => result.outputFiles[0].text));
    }
    return sources.get(entry);
}

async function fixture(entry, globals) {
    const module = { exports: {} };
    runInNewContext(await compile(entry), { module, exports: module.exports, ...globals });
    return module.exports;
}

async function bridgeFixture(t, { holdAttach = false } = {}) {
    const instances = [];
    class Inspector {
        inspectorUrl = '';
        detached = false;
        constructor(options) {
            this.options = options;
            instances.push(this);
        }
        async attach() {
            if (holdAttach) await new Promise((resolve, reject) => {
                this.finishAttach = resolve;
                this.cancelAttach = reject;
            });
            if (this.detached) throw new Error('attach cancelled');
            this.inspectorUrl = 'ws://127.0.0.1/' + instances.indexOf(this);
        }
        async detach() {
            this.detached = true;
            this.inspectorUrl = '';
            this.cancelAttach?.(new Error('attach cancelled'));
        }
    }
    const { installInspectorBridge } = await fixture('src/inspector/bridge.ts', { __test_inspector__: Inspector });
    const bridge = installInspectorBridge({ entryFile: 'fixture.ts' });
    t.after(() => bridge.dispose());
    return { bridge, instances };
}

test('inspector concurrent opens share loading and attach', async t => {
    const { bridge, instances } = await bridgeFixture(t);
    const urls = await Promise.all([bridge.open({ port: 1234 }), bridge.open({ port: 5678 })]);
    assert.equal(instances.length, 1);
    assert.equal(instances[0].options.port, 1234);
    assert.equal(urls[0], urls[1]);
    assert.equal(bridge.url(), urls[0]);
});

test('inspector close during loading cancels construction and allows reopening', async t => {
    const { bridge, instances } = await bridgeFixture(t);
    const rejected = assert.rejects(bridge.open(), /Inspector bridge is closed/);
    await bridge.close();
    await rejected;
    assert.equal(instances.length, 0);
    assert.equal(bridge.url(), undefined);
    assert.equal(bridge.isActive(), false);
    assert.match(await bridge.open(), /^ws:/);
    assert.equal(instances.length, 1);
});

test('inspector disposal during loading cancels construction permanently', async t => {
    const { bridge, instances } = await bridgeFixture(t);
    const rejected = assert.rejects(bridge.open(), /Inspector bridge is closed/);
    await bridge.dispose();
    await rejected;
    assert.equal(instances.length, 0);
    await assert.rejects(bridge.open(), /Inspector bridge is closed/);
});

test('inspector close cancels an attach already in progress', async t => {
    const { bridge, instances } = await bridgeFixture(t, { holdAttach: true });
    const rejected = assert.rejects(bridge.open(), /attach cancelled/);
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(instances.length, 1);
    await bridge.close();
    await rejected;
    assert.equal(instances[0].detached, true);
    assert.equal(bridge.isActive(), false);
});

test('inspector can reopen while an earlier close is completing', async t => {
    const { bridge, instances } = await bridgeFixture(t);
    await bridge.open();
    const closing = bridge.close();
    const reopening = bridge.open();
    await closing;
    assert.match(await reopening, /^ws:/);
    assert.equal(instances.length, 2);
    assert.equal(instances[0].detached, true);
    assert.equal(instances[1].detached, false);
});

test('REPL configures raw VT input and restores normal mode', async () => {
    const modes = [];
    class TTY {
        size = [80, 24];
        constructor(fd) { this.fd = fd; }
        set mode(value) { modes.push([this.fd, value]); }
    }
    const native = {
        os: { STDIN_FILENO: 0, STDOUT_FILENO: 1, guessHandle: () => 'tty' },
        streams: { TTY, TTY_MODE_RAW_VT: 2, TTY_MODE_NORMAL: 0 },
        fs: {},
    };
    const { LineEditor } = await fixture('src/commands/repl/line-editor.ts', { __test_use__: name => native[name] });
    const editor = new LineEditor({}, { tty: true });
    assert.deepEqual(modes, [[0, 2]]);
    editor.setTerminalMode(0);
    assert.deepEqual(modes, [[0, 2], [0, 0]]);
});

test('REPL file input does not create a terminal or set its mode', async () => {
    let terminals = 0;
    const native = {
        os: { STDIN_FILENO: 0, STDOUT_FILENO: 1, guessHandle: () => 'file' },
        streams: { TTY: class { constructor() { terminals++; } } },
        fs: {},
    };
    const { LineEditor } = await fixture('src/commands/repl/line-editor.ts', { __test_use__: name => native[name] });
    new LineEditor({}, { tty: false });
    assert.equal(terminals, 0);
});
