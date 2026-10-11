import { deepStrictEqual, strictEqual } from 'node:assert';
import { Http2Session } from '../../cno/src/node/http2/session.ts';

function attach(session: Http2Session, events: string[]) {
    const configured: unknown[] = [];
    const native = {
        onsettings: (ack: boolean) => { events.push(`native:${ack}`); },
        configure(settings: object) {
            const names = ['headerTableSize', 'enablePush', 'maxConcurrentStreams', 'initialWindowSize', 'maxFrameSize', 'maxHeaderListSize'];
            if (names.some(name => Reflect.get(settings, name) !== undefined)) configured.push(settings);
        },
    };
    Reflect.set(session, 'conn', { session: native, close() {}, destroy() {} });
    Reflect.get(session, 'onTransportAttached').call(session, false);
    session.on('localSettings', () => events.push('local'));
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
    deepStrictEqual(events, ['native:false']);
    native.onsettings(true);
    deepStrictEqual(events, ['native:false', 'native:true', 'local']);
    strictEqual(session.pendingSettingsAck, true, 'initial ACK must leave explicit SETTINGS pending');
    native.onsettings(true);
    native.onsettings(true);
    deepStrictEqual(events.slice(3), ['native:true', 'first', 'local', 'native:true', 'local']);
    strictEqual(session.pendingSettingsAck, true);
    native.onsettings(true);
    deepStrictEqual(events.slice(-3), ['native:true', 'third', 'local']);
    strictEqual(session.pendingSettingsAck, false);
    session.destroy();
});

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
