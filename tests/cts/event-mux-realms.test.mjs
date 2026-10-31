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

function runtime({ evbus = true, missingThrows = false } = {}) {
    const values = new Map();
    let listeners = [];
    let receiver;
    const registrations = [];
    const key = (namespace, name) => `${namespace}\0${name}`;

    function busFor(owner) {
        return {
            get(namespace, name) { return values.get(key(namespace, name))?.value; },
            set(namespace, name, value) { values.set(key(namespace, name), { owner, value }); },
            on(namespace, event, fn) {
                const entry = { owner, key: key(namespace, event), fn };
                listeners.push(entry);
                return () => { listeners = listeners.filter((item) => item !== entry); };
            },
            emit(namespace, event, payload) {
                const snapshot = listeners.filter((entry) => entry.key === key(namespace, event));
                for (const entry of snapshot) entry.fn(payload);
                return snapshot.length !== 0;
            },
        };
    }

    return {
        realm(owner, { sandbox = false, worker = false } = {}) {
            let engine;
            const bus = busFor(owner);
            const target = new EventTarget();
            const module = { exports: {} };
            const context = vm.createContext({
                module,
                exports: module.exports,
                Event,
                addEventListener: target.addEventListener.bind(target),
                removeEventListener: target.removeEventListener.bind(target),
                dispatchEvent: target.dispatchEvent.bind(target),
                __setNative(fn) {
                    if (sandbox) throw new TypeError('cannot call in sandbox mode');
                    receiver = fn;
                    registrations.push(fn);
                },
                __use(name) {
                    if (name === 'engine') return engine;
                    if (name === 'evbus' && evbus) return bus;
                    if (missingThrows) throw new Error('unknown native module');
                    return null;
                },
            });
            engine = { EventType: events, onEvent: vm.runInContext('(fn) => __setNative(fn)', context) };
            if (!sandbox) {
                Object.defineProperty(context, 'isWorker', {
                    value: worker, writable: false, configurable: false, enumerable: true,
                });
            }
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
        emit(name, data) { return receiver(name, data); },
        drop(owner) {
            listeners = listeners.filter((entry) => entry.owner !== owner);
            for (const [name, entry] of values) if (entry.owner === owner) values.delete(name);
        },
        get registrations() { return registrations; },
        get stateOwner() { return values.get(key('cno.engine.eventMux.v1', 'state'))?.owner; },
    };
}

test('native bus multiplexes realms in priority and registration order', () => {
    const rt = runtime();
    const main = rt.realm('main').mux;
    const sandbox = rt.realm('sandbox', { sandbox: true }).mux;
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
    assert.equal(rt.emit(events.JOB_EXCEPTION, 'failure'), true);
    assert.deepEqual(seen, ['sandbox-high', 'main-first', 'sandbox-first', 'main-second']);
    assert.equal(contexts.get('main-first'), contexts.get('main-second'));
    assert.equal(contexts.get('sandbox-high'), contexts.get('sandbox-first'));
    assert.equal(contexts.get('main-first'), contexts.get('sandbox-first'));
    assert.ok(rt.registrations.length > 0);
    assert.ok(rt.registrations.every((fn) => fn === rt.registrations[0]), 'same native receiver is reasserted');
});

test('one cross-realm dispatch shares handled state and native return', () => {
    const rt = runtime();
    const main = rt.realm('main').mux;
    const sandbox = rt.realm('sandbox', { sandbox: true }).mux;
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
    assert.equal(rt.emit(events.UNHANDLED_REJECTION, 'reason'), false);
    assert.deepEqual(calls, ['webapi', 'diagnostics'], 'each receiver runs once per native event');
});

test('cross-realm snapshots survive removal and preserve sticky lifecycle returns', () => {
    const rt = runtime();
    const main = rt.realm('main').mux;
    const sandbox = rt.realm('sandbox', { sandbox: true }).mux;
    const seen = [];
    main.installEventReceiver('main', () => {
        seen.push('main');
        rt.drop('sandbox');
        return true;
    }, 10);
    sandbox.installEventReceiver('sandbox', () => { seen.push('sandbox'); return false; }, 0);
    assert.equal(rt.emit(events.BEFORE_UNLOAD), true);
    assert.deepEqual(seen, ['main', 'sandbox']);
    seen.length = 0;
    assert.equal(rt.emit(events.BEFORE_UNLOAD), true);
    assert.deepEqual(seen, ['main']);
});

test('recursive dispatch has an independent context and stable receiver snapshot', () => {
    const rt = runtime();
    const main = rt.realm('main').mux;
    const sandbox = rt.realm('sandbox', { sandbox: true }).mux;
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
    rt.emit(events.EXIT, 'outer');
    assert.deepEqual(calls, ['main:outer:false', 'main:inner:false', 'sandbox:outer:true']);
});

test('lifecycle listener exceptions propagate and do not leave muxes dispatching', () => {
    const rt = runtime();
    const main = rt.realm('main').mux;
    const sandbox = rt.realm('sandbox', { sandbox: true }).mux;
    const marker = new Error('beforeunload');
    const off = sandbox.installEventReceiver('throws', () => { throw marker; }, 100);
    main.installEventReceiver('quiet', () => undefined);
    assert.throws(() => rt.emit(events.BEFORE_UNLOAD), (error) => error === marker);
    off();
    let called = false;
    main.installEventReceiver('after-error', () => { called = true; return undefined; });
    rt.emit(events.EXIT);
    assert.equal(called, true);
});

test('lifecycle guards are shared within a realm but not across realms', () => {
    const rt = runtime();
    const mainRealm = rt.realm('main');
    const sandboxRealm = rt.realm('sandbox', { sandbox: true });
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

test('sandbox-first state transfers to the native receiver owner', () => {
    const rt = runtime();
    const sandbox = rt.realm('sandbox', { sandbox: true }).mux;
    sandbox.installEventReceiver('sandbox', () => undefined);
    assert.equal(rt.stateOwner, 'sandbox');
    const main = rt.realm('main').mux;
    main.installEventReceiver('main', () => undefined);
    assert.equal(rt.stateOwner, 'main');
    rt.drop('sandbox');
    assert.equal(rt.stateOwner, 'main');
    assert.equal(rt.emit(events.JOB_EXCEPTION), true);
});

test('workers have isolated buses and do not fire unload through the compat bridge', () => {
    const parentRuntime = runtime();
    const workerRuntime = runtime();
    const parent = parentRuntime.realm('parent').mux;
    const workerRealm = workerRuntime.realm('worker', { worker: true });
    const worker = workerRealm.mux;
    const seen = [];
    parent.installEventReceiver('parent', () => { seen.push('parent'); return undefined; });
    worker.installWebApiCompatBridge();
    workerRealm.target.addEventListener('unload', () => seen.push('worker-unload'));
    workerRealm.target.addEventListener('exit', () => seen.push('worker-exit'));
    workerRuntime.emit(events.EXIT, 0);
    assert.deepEqual(seen, ['worker-exit']);
    assert.equal(worker.dispatchUnloadEvent(), false);
    parentRuntime.emit(events.EXIT, 0);
    assert.deepEqual(seen, ['worker-exit', 'parent']);
});

for (const missingThrows of [false, true]) {
    test(`older cores without evbus retain the local mux (throws=${missingThrows})`, () => {
        const rt = runtime({ evbus: false, missingThrows });
        const mainRealm = rt.realm('main');
        const main = mainRealm.mux;
        const sandbox = rt.realm('sandbox', { sandbox: true }).mux;
        const seen = [];
        main.installEventReceiver('main', () => { seen.push('main'); return undefined; });
        sandbox.installEventReceiver('sandbox', () => { seen.push('sandbox'); return undefined; });
        assert.equal(main.getEventMux(), mainRealm.load().getEventMux());
        assert.equal(rt.emit(events.JOB_EXCEPTION), true);
        assert.deepEqual(seen, ['main']);
        sandbox.getEventMux().dispatch(events.EXIT, 0);
        assert.deepEqual(seen, ['main', 'sandbox']);
    });
}
