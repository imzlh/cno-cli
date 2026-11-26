import { deepStrictEqual, strictEqual, throws } from 'node:assert';
import { Http2Session } from '../../cno/src/node/http2/session.ts';
import { getDefaultSettings } from '../../cno/src/node/http2/settings.ts';

function attach(session: Http2Session, events: string[]) {
    const configured: unknown[] = [];
    const native = {
        localSettings: getDefaultSettings(),
        remoteSettings: getDefaultSettings(),
        onsettings: (ack: boolean) => { events.push(`native:${ack}`); },
        configure(settings: object) {
            const names = ['headerTableSize', 'enablePush', 'maxConcurrentStreams', 'initialWindowSize', 'maxFrameSize', 'maxHeaderListSize'];
            if (names.some(name => Reflect.get(settings, name) !== undefined)) configured.push(settings);
        },
    };
    Reflect.set(session, 'conn', { session: native, close() {}, destroy() {} });
    Reflect.get(session, 'onTransportAttached').call(session, false);
    session.on('localSettings', () => events.push('local'));
    session.on('remoteSettings', () => events.push('remote'));
    return { native, configured };
}

Deno.test('http2: SETTINGS acknowledgements consume callbacks in frame order', () => {
    const session = new Http2Session(0);
    const events: string[] = [];
    session.settings({ maxConcurrentStreams: 1 }, () => events.push('first'));
    session.settings({ maxConcurrentStreams: 2 });
    const { native, configured } = attach(session, events);
    const handler = native.onsettings;
    session.settings({ maxConcurrentStreams: 3 }, () => events.push('third'));
    strictEqual(native.onsettings, handler, 'settings must not wrap the ACK handler again');
    strictEqual(configured.length, 3);

    native.onsettings(false);
    deepStrictEqual(events, ['native:false', 'remote']);
    native.onsettings(true);
    deepStrictEqual(events, ['native:false', 'remote', 'native:true', 'local']);
    strictEqual(session.pendingSettingsAck, true, 'initial ACK must leave explicit SETTINGS pending');
    native.onsettings(true);
    native.onsettings(true);
    deepStrictEqual(events.slice(4), ['native:true', 'first', 'local', 'native:true', 'local']);
    strictEqual(session.pendingSettingsAck, true);
    native.onsettings(true);
    deepStrictEqual(events.slice(-3), ['native:true', 'third', 'local']);
    strictEqual(session.pendingSettingsAck, false);
    session.destroy();
});

Deno.test('http2: local settings are available before transport attachment', () => {
    const session = new Http2Session(0, { initialWindowSize: 131072 });
    strictEqual(session.localSettings.initialWindowSize, 131072);
    strictEqual(session.localSettings.headerTableSize, getDefaultSettings().headerTableSize);
    strictEqual(session.localSettings.maxHeaderListSize, getDefaultSettings().maxHeaderListSize);
    session.destroy();
});

Deno.test('http2: ping callbacks match ACK payloads and reject invalid lengths', () => {
    const session = new Http2Session(0);
    let onping: ((isAck: boolean, payload: Uint8Array) => void) | null = null;
    const sent: Uint8Array[] = [];
    Reflect.set(session, 'conn', {
        session: {
            localSettings: getDefaultSettings(),
            remoteSettings: getDefaultSettings(),
            configure() {},
            ping(payload: Uint8Array) { sent.push(payload); },
            get onping() { return onping; },
            set onping(value: typeof onping) { onping = value; },
        },
        close() {},
        destroy() {},
    });
    Reflect.get(session, 'onTransportAttached').call(session, false);

    const callbacks: string[] = [];
    const first = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]);
    const second = new Uint8Array([8, 7, 6, 5, 4, 3, 2, 1]);
    session.ping(first, (error, _duration, payload) => callbacks.push(`first:${error}:${payload[0]}`));
    session.ping(second, (error, _duration, payload) => callbacks.push(`second:${error}:${payload[0]}`));
    session.ping(first, (error, _duration, payload) => callbacks.push(`third:${error}:${payload[0]}`));
    session.ping(undefined, (error, _duration, payload) => callbacks.push(`default:${error}:${payload.length}`));
    strictEqual(sent.length, 4);
    strictEqual(sent[3]?.byteLength, 8);
    throws(() => session.ping(new Uint8Array(7)), { code: 'ERR_HTTP2_PING_LENGTH' });
    onping?.(true, second);
    onping?.(true, first);
    onping?.(true, first);
    onping?.(true, sent[3]!);
    deepStrictEqual(callbacks, ['second:null:8', 'first:null:1', 'third:null:1', 'default:null:8']);
    session.destroy();
});

Deno.test('http2: closing a session cancels pings before close with only an error', () => {
    const session = new Http2Session(0);
    const events: string[] = [];
    const native = {
        localSettings: getDefaultSettings(),
        remoteSettings: getDefaultSettings(),
        configure() {},
        ping() {},
    };
    Reflect.set(session, 'conn', { session: native, close() {}, destroy() {} });
    Reflect.get(session, 'onTransportAttached').call(session, false);

    let callbackArgs: unknown[] | undefined;
    session.on('close', () => events.push('close'));
    session.ping(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]), (...args) => {
        callbackArgs = args;
        events.push('ping');
    });
    session.close();

    strictEqual(callbackArgs?.length, 1);
    strictEqual((callbackArgs?.[0] as { code?: string }).code, 'ERR_HTTP2_PING_CANCEL');
    deepStrictEqual(events, ['ping', 'close']);
});

for (const terminal of ['close', 'destroy'] as const) {
    Deno.test(`http2: ${terminal} completes teardown when cancellation and error listeners throw`, async () => {
        const session = new Http2Session(0);
        const events: string[] = [];
        const callbackFailure = new Error('ping listener failed');
        const transportFailure = new Error('transport failed');
        Reflect.set(session, 'conn', {
            session: {
                localSettings: getDefaultSettings(),
                remoteSettings: getDefaultSettings(),
                configure() {},
                ping() {},
            },
            close() { events.push('transport'); },
            destroy() { events.push('transport'); },
        });
        Reflect.get(session, 'onTransportAttached').call(session, false);
        session.settings({ maxConcurrentStreams: 1 }, () => {});
        session.setTimeout(60_000);
        session.on('error', error => {
            strictEqual(error, transportFailure);
            events.push('error');
            throw new Error('error listener failed');
        });
        session.on('close', () => events.push('close'));
        const payload = new Uint8Array(8);
        session.ping(payload, error => {
            strictEqual((error as NodeJS.ErrnoException | null)?.code, 'ERR_HTTP2_PING_CANCEL');
            events.push('first');
            throw callbackFailure;
        });
        session.ping(payload, error => {
            strictEqual((error as NodeJS.ErrnoException | null)?.code, 'ERR_HTTP2_PING_CANCEL');
            events.push('second');
        });
        let callbackRan = false;
        try {
            throws(() => terminal === 'close'
                ? session.close(() => { callbackRan = true; })
                : session.destroy(transportFailure), error => error === callbackFailure);
            strictEqual(Reflect.get(session, 'conn'), null);
            strictEqual(Reflect.get(session, 'timeoutTimer'), null);
            strictEqual(Reflect.get(session, 'settingsAckWaiters').length, 0);
            strictEqual(session.pendingSettingsAck, false);
            strictEqual(events.filter(event => event === 'transport').length, 1);
            deepStrictEqual(events.filter(event => event !== 'transport'),
                terminal === 'close' ? ['first', 'second', 'close'] : ['first', 'second', 'error', 'close']);
            await Promise.resolve();
            strictEqual(callbackRan, terminal === 'close');
        } finally {
            session.setTimeout(0);
            session.destroy();
        }
    });
}

Deno.test('http2: repeated settings calls keep one ACK handler and one event per ACK', () => {
    const session = new Http2Session(0);
    const events: string[] = [];
    const { native } = attach(session, events);
    native.onsettings(true);
    const handler = native.onsettings;
    events.length = 0;
    for (let index = 0; index < 20; index++) {
        session.settings({ maxConcurrentStreams: index + 1 }, () => events.push('callback'));
        strictEqual(native.onsettings, handler);
        native.onsettings(true);
        strictEqual(session.pendingSettingsAck, false);
    }
    deepStrictEqual(events, Array.from({ length: 20 }, () => ['native:true', 'callback', 'local']).flat());
    session.destroy();
});

Deno.test('http2: empty and ignored settings still submit frames before later callbacks', () => {
    const session = new Http2Session(0);
    const events: string[] = [];
    const { native, configured } = attach(session, events);
    native.onsettings(true);
    events.length = 0;
    session.settings({}, () => events.push('empty'));
    session.settings({ unknownSetting: 1 }, () => events.push('ignored'));
    session.settings({ headerTableSize: 1024 }, () => events.push('next'));
    strictEqual(configured.length, 3);
    for (const _frame of configured) native.onsettings(true);
    deepStrictEqual(events, ['native:true', 'empty', 'local', 'native:true', 'ignored', 'local', 'native:true', 'next', 'local']);
    strictEqual(session.pendingSettingsAck, false);
    session.destroy();
});

for (const terminal of ['close', 'destroy'] as const) {
    Deno.test(`http2: ${terminal} releases queued SETTINGS references`, () => {
        const session = new Http2Session(0);
        session.settings({ maxConcurrentStreams: 1 }, () => {});
        session[terminal]();
        strictEqual(Reflect.get(session, 'queuedSettings').length, 0);
        strictEqual(Reflect.get(session, 'settingsAckWaiters').length, 0);
        strictEqual(session.pendingSettingsAck, false);
    });
}
