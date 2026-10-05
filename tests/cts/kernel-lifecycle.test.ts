import { deepStrictEqual, rejects, strictEqual } from 'node:assert';
import { rmSync } from 'node:fs';
import { makePosixTempDir } from '../_helpers/temp.ts';
import { TypeScriptRuntime } from '../../cts/src/runtime/index.ts';
import { openKernelRuntime, type KernelContext, type KernelRuntime } from '../../src/kernel.ts';
import { Inspector } from '../../src/inspector/main/inspector.ts';
import { installInspectorBridge, type InstalledInspectorBridge } from '../../src/inspector/bridge.ts';

const bridgeKey = Symbol.for('cno.inspector.bridge');
const kernel: KernelContext = { config: {}, inspect: null, runtimeFlags: {}, preloads: [], nodePreloads: [] };

async function withInspectorMock(fn: (mock: {
    opened: Inspector[];
    detached: Inspector[];
    unrefed: Inspector[];
    hooks: Array<NonNullable<Inspector['scriptInitHook']>>;
    attach?: (inspector: Inspector) => Promise<void>;
    detach?: (inspector: Inspector) => Promise<void>;
}) => Promise<void>): Promise<void> {
    const descriptor = Object.getOwnPropertyDescriptor(globalThis, bridgeKey);
    const { attach, detach, allowProcessExit } = Inspector.prototype;
    const { addInitHook } = TypeScriptRuntime.prototype;
    const mock: Parameters<typeof fn>[0] = { opened: [], detached: [], unrefed: [], hooks: [] };
    Inspector.prototype.attach = async function () {
        mock.opened.push(this);
        if (mock.attach) await mock.attach(this);
        this.inspectorUrl = `ws://127.0.0.1/${mock.opened.length}`;
    };
    Inspector.prototype.detach = async function () {
        mock.detached.push(this);
        if (mock.detach) await mock.detach(this);
        this.inspectorUrl = '';
    };
    Inspector.prototype.allowProcessExit = function () { mock.unrefed.push(this); };
    TypeScriptRuntime.prototype.addInitHook = function (hook) {
        mock.hooks.push(hook);
        addInitHook.call(this, hook);
    };
    try { await fn(mock); }
    finally {
        Object.assign(Inspector.prototype, { attach, detach, allowProcessExit });
        TypeScriptRuntime.prototype.addInitHook = addInitHook;
        if (descriptor) Object.defineProperty(globalThis, bridgeKey, descriptor);
        else Reflect.deleteProperty(globalThis, bridgeKey);
    }
}

async function withRuntime(context: KernelContext, fn: (session: KernelRuntime) => Promise<void>): Promise<void> {
    const dir = makePosixTempDir('kernel-lifecycle');
    let session: KernelRuntime | undefined;
    try {
        session = await openKernelRuntime(context, 'entry.ts', { cacheDir: dir, disableLock: true, enableOxc: false }, dir);
        await fn(session);
    } finally {
        try { await session?.close(); } catch { /* individual tests assert cleanup failures */ }
        rmSync(dir, { recursive: true, force: true });
    }
}

Deno.test('kernel lifecycle: finish keeps the bridge usable and late inspectors unrefed', async () => {
    await withInspectorMock(async (mock) => {
        await withRuntime(kernel, async (session) => {
            const bridge = Reflect.get(globalThis, bridgeKey) as InstalledInspectorBridge;
            session.finish();
            await new Promise<void>(resolve => setTimeout(resolve, 0));
            strictEqual(Reflect.get(globalThis, bridgeKey), bridge);
            await bridge.open({ port: 0 });
            deepStrictEqual(mock.unrefed, mock.opened);
            const closing = session.close();
            strictEqual(session.close(), closing);
            await closing;
            strictEqual(mock.detached.length, 1);
            strictEqual(Reflect.get(globalThis, bridgeKey), undefined);
            await rejects(bridge.open(), /closed/);
        });
    });
});

Deno.test('kernel lifecycle: one init hook follows the current inspector across reopen', async () => {
    await withInspectorMock(async (mock) => {
        const notifications: Inspector[] = [];
        mock.attach = async (inspector) => {
            inspector.scriptInitHook = () => { notifications.push(inspector); };
        };
        await withRuntime(kernel, async (session) => {
            const bridge = Reflect.get(globalThis, bridgeKey) as InstalledInspectorBridge;
            await bridge.open();
            await bridge.close();
            await bridge.open();
            strictEqual(mock.hooks.length, 1);
            const info = { specPath: 'entry.ts', localPath: 'entry.ts', format: 'esm', fileKind: 'source' } as const;
            mock.hooks[0]!('entry.ts', info);
            deepStrictEqual(notifications, [mock.opened[1]]);
            await session.close();
            mock.hooks[0]!('entry.ts', info);
            strictEqual(notifications.length, 1);
        });
    });
});

Deno.test('kernel lifecycle: initialization failures release resources and preserve the original error', async () => {
    await withInspectorMock(async (mock) => {
        const failure = new Error('preload failed');
        mock.detach = async () => { throw new Error('detach failed'); };
        await withRuntime({ ...kernel, preloads: ['broken.ts'] }, async (session) => {
            const bridge = Reflect.get(globalThis, bridgeKey) as InstalledInspectorBridge;
            await bridge.open();
            session.runtime.loadModule = async () => { throw failure; };
            const cleanup = session.runtime.cleanup.bind(session.runtime);
            let cleanups = 0;
            session.runtime.cleanup = () => {
                cleanups++;
                cleanup();
                throw new Error('cleanup failed');
            };
            await rejects(session.initialize(), error => error === failure);
            strictEqual(cleanups, 1);
            strictEqual(mock.detached.length, 1);
            strictEqual(Reflect.get(globalThis, bridgeKey), undefined);
            await rejects(session.close(), /detach failed/);
            strictEqual(cleanups, 1);
        });
    });
});

Deno.test('inspector bridge: disposing an older bridge preserves its replacement', async () => {
    await withInspectorMock(async () => {
        const first = installInspectorBridge({ entryFile: 'first.ts' });
        const second = installInspectorBridge({ entryFile: 'second.ts' });
        try {
            await first.dispose();
            strictEqual(Reflect.get(globalThis, bridgeKey), second);
            await rejects(first.open(), /closed/);
            await second.open();
            strictEqual(second.isActive(), true);
        } finally { await second.dispose(); }
    });
});

Deno.test('kernel lifecycle: failed initial attach preserves its error during cleanup', async () => {
    await withInspectorMock(async (mock) => {
        const failure = new Error('attach failed');
        mock.attach = async () => { throw failure; };
        mock.detach = async () => { throw new Error('detach failed'); };
        await rejects(withRuntime({
            ...kernel,
            inspect: { host: '127.0.0.1', port: 0, breakOnStart: false, waitForClient: false },
        }, async () => { throw new Error('unreachable'); }), error => error === failure);
        strictEqual(mock.detached.length, 1);
    });
});

Deno.test('inspector bridge: close during attach prevents publishing a stopped inspector', async () => {
    await withInspectorMock(async (mock) => {
        let ready!: () => void;
        const attaching = new Promise<void>(resolve => { ready = resolve; });
        mock.attach = () => attaching;
        mock.detach = async () => { ready(); };
        let opened = false;
        const bridge = installInspectorBridge({ entryFile: 'entry.ts', onOpen: () => { opened = true; } });
        try {
            const opening = bridge.open();
            const rejected = rejects(opening, /closed/);
            await bridge.close();
            await rejected;
            strictEqual(opened, false);
            strictEqual(bridge.isActive(), false);
        } finally { await bridge.dispose(); }
    });
});

Deno.test('inspector bridge: reopening waits for pending close', async () => {
    await withInspectorMock(async (mock) => {
        let release!: () => void;
        const stopped = new Promise<void>(resolve => { release = resolve; });
        mock.detach = () => stopped;
        const bridge = installInspectorBridge({ entryFile: 'entry.ts' });
        try {
            await bridge.open();
            const closing = bridge.close();
            const reopening = bridge.open();
            await Promise.resolve();
            strictEqual(mock.opened.length, 1);
            release();
            await closing;
            await reopening;
            strictEqual(mock.opened.length, 2);
            strictEqual(bridge.isActive(), true);
        } finally {
            release();
            await bridge.dispose();
        }
    });
});
