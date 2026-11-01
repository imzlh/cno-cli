// @cno-host: false
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';
import { transformSync } from 'esbuild';

const source = readFileSync(new URL('../../cts/src/runtime/event-mux.ts', import.meta.url), 'utf8');
const compiled = transformSync(source, {
    loader: 'ts',
    format: 'cjs',
    target: 'es2022',
    define: { 'import.meta.use': 'globalThis.__use' },
}).code;

const events = {
    UNHANDLED_REJECTION: 0,
    JOB_EXCEPTION: 1,
    EXIT: 2,
    LOAD: 3,
    BEFORE_UNLOAD: 4,
    BEFORE_EXIT: 5,
};

function runtime() {
    const namespace = 'circu.runtime';
    const event = 'event';
    let listeners = [];
    let sequence = 0;
    const key = (ns, name) => `${ns}\0${name}`;

    function busFor(realm) {
        return {
            RUNTIME_NAMESPACE: namespace,
            RUNTIME_EVENT: event,
            on(ns, name, fn, priority = 0) {
                const entry = { realm, key: key(ns, name), fn, priority, sequence: sequence++, active: true };
                listeners.push(entry);
                return () => {
                    if (!entry.active) return;
                    entry.active = false;
                    listeners = listeners.filter((item) => item !== entry);
                };
            },
            dispatchRuntimeEvent(name, data) {
                const context = { handled: false, dispatched: false, rejectionEmitted: false };
                const snapshot = listeners
                    .filter((entry) => entry.active && entry.key === key(namespace, event))
                    .sort((a, b) => (b.priority - a.priority) || (a.sequence - b.sequence));
                let result = name === events.JOB_EXCEPTION;
                for (const entry of snapshot) {
                    let value;
                    try {
                        value = entry.fn({ name, data, context });
                    } catch (error) {
                        if (name === events.BEFORE_UNLOAD || name === events.BEFORE_EXIT) throw error;
                        continue;
                    }
                    if (typeof value === 'boolean') {
                        result = name === events.BEFORE_UNLOAD ? result || value : value;
                    }
                }
                return result;
            },
        };
    }

    return {
        realm(realm, { worker = false } = {}) {
            const bus = busFor(realm);
            const target = new EventTarget();
            const module = { exports: {} };
            const context = vm.createContext({
                module,
                exports: module.exports,
                Event,
                addEventListener: target.addEventListener.bind(target),
                removeEventListener: target.removeEventListener.bind(target),
                dispatchEvent: target.dispatchEvent.bind(target),
                __use(name) {
                    if (name === 'engine') return { EventType: events };
                    if (name === 'evbus') return bus;
                    throw new Error(`unknown native module: ${name}`);
                },
            });
            Object.defineProperty(context, 'isWorker', {
                value: worker, writable: false, configurable: false, enumerable: true,
            });
            const load = () => {
                context.module = { exports: {} };
                context.exports = context.module.exports;
                vm.runInContext(`(function(module, exports) {\n${compiled}\n})(module, exports)`, context, {
                    filename: 'event-mux.cjs',
                });
                return context.module.exports;
            };
            return { mux: load(), load, target };
        },
        dispatch(name, data) {
            return busFor('test').dispatchRuntimeEvent(name, data);
        },
        listenerCount(realm) {
            return listeners.filter((entry) => entry.realm === realm).length;
        },
    };
}

test('direct runtime subscriptions order all realms by priority and registration', () => {
    const rt = runtime();
    const main = rt.realm('main').mux;
    const sandbox = rt.realm('sandbox').mux;
    const seen = [];
    const contexts = new Map();
    const add = (api, role, priority, result) => api.installEventReceiver(role, (_name, _data, ctx) => {
        seen.push(role);
        contexts.set(role, ctx);
        return result;
    }, priority);

    add(main, 'main-first', 10, true);
    add(sandbox, 'sandbox-first', 10, false);
    add(main, 'main-second', 10, true);
    add(sandbox, 'sandbox-high', 20, undefined);

    assert.equal(rt.dispatch(events.JOB_EXCEPTION, 'failure'), true);
    assert.deepEqual(seen, ['sandbox-high', 'main-first', 'sandbox-first', 'main-second']);
    assert.equal(contexts.get('main-first'), contexts.get('main-second'));
    assert.equal(contexts.get('main-first'), contexts.get('sandbox-first'));
    assert.equal(contexts.get('sandbox-high'), contexts.get('sandbox-first'));
    assert.equal(rt.listenerCount('main'), 2);
    assert.equal(rt.listenerCount('sandbox'), 2);
});

test('one native dispatch shares context and aggregates independent subscriptions', () => {
    const rt = runtime();
    const main = rt.realm('main').mux;
    const sandbox = rt.realm('sandbox').mux;
    const calls = [];

    sandbox.installEventReceiver('webapi', (_name, _data, ctx) => {
        calls.push('webapi');
        ctx.handled = true;
        ctx.dispatched = true;
        ctx.rejectionEmitted = true;
        return true;
    }, 100);
    main.installEventReceiver('diagnostics', (_name, _data, ctx) => {
        calls.push('diagnostics');
        assert.equal(ctx.handled, true);
        assert.equal(ctx.dispatched, true);
        assert.equal(ctx.rejectionEmitted, true);
        return false;
    }, 0);

    assert.equal(rt.dispatch(events.UNHANDLED_REJECTION, 'reason'), false);
    assert.deepEqual(calls, ['webapi', 'diagnostics']);
});

test('unsubscribing one realm leaves every other native subscription active', () => {
    const rt = runtime();
    const main = rt.realm('main').mux;
    const sandbox = rt.realm('sandbox').mux;
    const seen = [];
    const offMain = main.installEventReceiver('main', () => { seen.push('main'); return true; }, 10);
    const offSandbox = sandbox.installEventReceiver('sandbox', () => { seen.push('sandbox'); return false; }, 0);

    assert.equal(rt.dispatch(events.JOB_EXCEPTION), false);
    assert.deepEqual(seen, ['main', 'sandbox']);

    seen.length = 0;
    offSandbox();
    offSandbox();
    assert.equal(rt.listenerCount('sandbox'), 0);
    assert.equal(rt.dispatch(events.JOB_EXCEPTION), true);
    assert.deepEqual(seen, ['main']);
    offMain();
});

test('same-role replacement detaches the old native subscription', () => {
    const rt = runtime();
    const realm = rt.realm('main');
    const seen = [];
    const offOld = realm.mux.installEventReceiver('role', () => { seen.push('old'); });
    const offNew = realm.mux.installEventReceiver('role', () => { seen.push('new'); });

    assert.equal(rt.listenerCount('main'), 1);
    rt.dispatch(events.EXIT, 0);
    assert.deepEqual(seen, ['new']);

    offOld();
    assert.equal(rt.listenerCount('main'), 1, 'the stale off function must not remove its replacement');
    offNew();
    assert.equal(rt.listenerCount('main'), 0);
});

test('dispatch snapshots survive removal and preserve sticky beforeunload returns', () => {
    const rt = runtime();
    const main = rt.realm('main').mux;
    const sandbox = rt.realm('sandbox').mux;
    const seen = [];
    let offSandbox;
    main.installEventReceiver('main', () => {
        seen.push('main');
        offSandbox();
        return true;
    }, 10);
    offSandbox = sandbox.installEventReceiver('sandbox', () => { seen.push('sandbox'); return false; }, 0);

    assert.equal(rt.dispatch(events.BEFORE_UNLOAD), true);
    assert.deepEqual(seen, ['main', 'sandbox']);
    seen.length = 0;
    assert.equal(rt.dispatch(events.BEFORE_UNLOAD), true);
    assert.deepEqual(seen, ['main']);
});

test('recursive dispatch gets a fresh context and a separate stable snapshot', () => {
    const rt = runtime();
    const main = rt.realm('main').mux;
    const sandbox = rt.realm('sandbox').mux;
    const calls = [];
    let offSandbox;
    main.installEventReceiver('main', (_name, data, ctx) => {
        calls.push(`main:${data}:${ctx.handled}`);
        if (data === 'outer') {
            ctx.handled = true;
            offSandbox();
            main.getEventMux().dispatch(events.EXIT, 'inner');
        }
    }, 100);
    offSandbox = sandbox.installEventReceiver('sandbox', (_name, data, ctx) => {
        calls.push(`sandbox:${data}:${ctx.handled}`);
    }, 0);

    rt.dispatch(events.EXIT, 'outer');
    assert.deepEqual(calls, ['main:outer:false', 'main:inner:false', 'sandbox:outer:true']);
});

test('lifecycle exceptions propagate without poisoning later dispatches', () => {
    const rt = runtime();
    const main = rt.realm('main').mux;
    const sandbox = rt.realm('sandbox').mux;
    const marker = new Error('beforeunload');
    const off = sandbox.installEventReceiver('throws', () => { throw marker; }, 100);
    main.installEventReceiver('quiet', () => undefined);

    assert.throws(() => rt.dispatch(events.BEFORE_UNLOAD), (error) => error === marker);
    off();
    let called = false;
    main.installEventReceiver('after-error', () => { called = true; });
    rt.dispatch(events.EXIT);
    assert.equal(called, true);
});

test('facade identity and lifecycle guards stay realm-local', () => {
    const rt = runtime();
    const mainRealm = rt.realm('main');
    const sandboxRealm = rt.realm('sandbox');
    const main = mainRealm.mux;
    const sandbox = sandboxRealm.mux;
    const mainCopy = mainRealm.load();
    const seen = [];
    mainRealm.target.addEventListener('load', () => seen.push('main-load'));
    sandboxRealm.target.addEventListener('load', () => seen.push('sandbox-load'));
    mainRealm.target.addEventListener('unload', () => seen.push('main-unload'));
    sandboxRealm.target.addEventListener('unload', () => seen.push('sandbox-unload'));

    assert.equal(main.getEventMux(), mainCopy.getEventMux());
    assert.notEqual(main.getEventMux(), sandbox.getEventMux());
    assert.equal(main.dispatchLoadEvent(), true);
    assert.equal(mainCopy.dispatchLoadEvent(), false);
    assert.equal(sandbox.dispatchLoadEvent(), true);
    assert.equal(main.dispatchUnloadEvent(), true);
    assert.equal(sandbox.unloadEventFired(), false);
    assert.equal(sandbox.dispatchUnloadEvent(), true);
    assert.deepEqual(seen, ['main-load', 'sandbox-load', 'main-unload', 'sandbox-unload']);
});

test('workers use an isolated runtime bus and skip unload compatibility events', () => {
    const parentRuntime = runtime();
    const workerRuntime = runtime();
    const parent = parentRuntime.realm('parent').mux;
    const workerRealm = workerRuntime.realm('worker', { worker: true });
    const worker = workerRealm.mux;
    const seen = [];
    parent.installEventReceiver('parent', () => { seen.push('parent'); });
    worker.installWebApiCompatBridge();
    workerRealm.target.addEventListener('unload', () => seen.push('worker-unload'));
    workerRealm.target.addEventListener('exit', () => seen.push('worker-exit'));

    workerRuntime.dispatch(events.EXIT, 0);
    assert.deepEqual(seen, ['worker-exit']);
    assert.equal(worker.dispatchUnloadEvent(), false);
    parentRuntime.dispatch(events.EXIT, 0);
    assert.deepEqual(seen, ['worker-exit', 'parent']);
});
