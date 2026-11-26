import { strictEqual, throws } from 'node:assert';
import * as http2 from 'node:http2';
import { h2Available } from '@cnojs/http/h2-native';

function closeServer(server: {
    readonly listening: boolean;
    close(callback?: (error?: Error) => void): unknown;
}): Promise<void> {
    if (!server.listening) return Promise.resolve();
    return new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
}

function nextRemoteSettings(session: { once(event: string, listener: () => void): unknown }): Promise<void> {
    return new Promise(resolve => session.once('remoteSettings', () => resolve()));
}

Deno.test({
    name: 'http2: custom SETTINGS reach the wire initially and on session updates',
    ignore: !h2Available(),
    timeout: 15000,
}, async () => {
    const serverSettingId = 0xf001;
    const clientSettingId = 0xf002;
    const server = http2.createServer({ settings: { customSettings: { [serverSettingId]: 41 } } });
    let serverSession: http2.ServerHttp2Session | undefined;
    let resolveServerSession!: (session: http2.ServerHttp2Session) => void;
    let resolveServerInitialSettings!: () => void;
    const serverSessionReady = new Promise<http2.ServerHttp2Session>(resolve => {
        resolveServerSession = resolve;
    });
    const serverInitialSettings = new Promise<void>(resolve => {
        resolveServerInitialSettings = resolve;
    });
    server.once('session', session => {
        serverSession = session;
        session.once('remoteSettings', () => resolveServerInitialSettings());
        resolveServerSession(session);
    });

    let client: http2.ClientHttp2Session | undefined;
    try {
        await new Promise<void>((resolve, reject) => {
            server.once('error', reject);
            server.listen(0, '127.0.0.1', resolve);
        });
        const address = server.address();
        if (!address || typeof address !== 'object') throw new Error('HTTP/2 server did not bind');

        client = http2.connect(`http://127.0.0.1:${address.port}`, {
            settings: { customSettings: { [clientSettingId]: 17 } },
        });
        const clientInitialSettings = nextRemoteSettings(client);
        const attachedServerSession = await serverSessionReady;
        await Promise.all([clientInitialSettings, serverInitialSettings]);

        strictEqual(client.remoteSettings.customSettings?.[serverSettingId], 41);
        strictEqual(attachedServerSession.remoteSettings.customSettings?.[clientSettingId], 17);
        strictEqual(client.localSettings.customSettings?.[clientSettingId], 17);
        strictEqual(attachedServerSession.localSettings.customSettings?.[serverSettingId], 41);

        const fullSettings = {
            headerTableSize: 4096,
            enablePush: true,
            maxConcurrentStreams: 100,
            initialWindowSize: 65535,
            maxFrameSize: 16384,
            maxHeaderListSize: 65535,
            enableConnectProtocol: true,
            customSettings: Object.fromEntries(
                Array.from({ length: 10 }, (_, index) => [serverSettingId + 1 + index, index + 1]),
            ),
        };
        const fullSettingsReceived = nextRemoteSettings(attachedServerSession);
        const fullSettingsAck = new Promise<void>((resolve, reject) => {
            client!.settings(fullSettings, error => error ? reject(error) : resolve());
        });
        await Promise.all([fullSettingsReceived, fullSettingsAck]);
        strictEqual(attachedServerSession.remoteSettings.enableConnectProtocol, true);
        strictEqual(attachedServerSession.remoteSettings.customSettings?.[serverSettingId + 10], 10);

        const clientUpdatedSettings = nextRemoteSettings(client);
        const serverUpdatedSettings = nextRemoteSettings(attachedServerSession);
        const clientUpdateAck = new Promise<void>((resolve, reject) => {
            client!.settings({ customSettings: { [clientSettingId]: 0 } }, error => error ? reject(error) : resolve());
        });
        const serverUpdateAck = new Promise<void>((resolve, reject) => {
            attachedServerSession.settings(
                { customSettings: { [serverSettingId]: 42 } },
                error => error ? reject(error) : resolve(),
            );
        });
        await Promise.all([clientUpdatedSettings, serverUpdatedSettings, clientUpdateAck, serverUpdateAck]);

        strictEqual(client.remoteSettings.customSettings?.[serverSettingId], 42);
        strictEqual(attachedServerSession.remoteSettings.customSettings?.[clientSettingId], 0);
        strictEqual(client.localSettings.customSettings?.[clientSettingId], 0);
        strictEqual(attachedServerSession.localSettings.customSettings?.[serverSettingId], 42);
        throws(
            () => client!.settings({ customSettings: { 1: 2 } }),
            { code: 'ERR_HTTP2_INVALID_SETTING_VALUE' },
        );
        const tooMany = Object.fromEntries(Array.from({ length: 11 }, (_, index) => [serverSettingId + index, index]));
        throws(
            () => client!.settings({ customSettings: tooMany }),
            { code: 'ERR_HTTP2_TOO_MANY_CUSTOM_SETTINGS' },
        );
    } finally {
        client?.destroy();
        serverSession?.destroy();
        await closeServer(server);
    }
});

Deno.test({
    name: 'http2: server customSettings can be cleared for future sessions',
    ignore: !h2Available(),
    timeout: 15000,
}, async () => {
    const settingId = 0xf010;
    const server = http2.createServer({ settings: { customSettings: { [settingId]: 23 } } });
    let first: http2.ClientHttp2Session | undefined;
    let next: http2.ClientHttp2Session | undefined;
    try {
        await new Promise<void>((resolve, reject) => {
            server.once('error', reject);
            server.listen(0, '127.0.0.1', resolve);
        });
        const address = server.address();
        if (!address || typeof address !== 'object') throw new Error('HTTP/2 server did not bind');
        const authority = `http://127.0.0.1:${address.port}`;

        first = http2.connect(authority);
        await nextRemoteSettings(first);
        strictEqual(first.remoteSettings.customSettings?.[settingId], 23);

        server.updateSettings({ customSettings: {} });
        next = http2.connect(authority);
        await nextRemoteSettings(next);
        strictEqual(next.remoteSettings.customSettings, undefined);

        for (const value of [null, 'invalid']) {
            throws(
                () => server.updateSettings({ customSettings: value }),
                { code: 'ERR_INVALID_ARG_TYPE' },
            );
        }
    } finally {
        first?.destroy();
        next?.destroy();
        await closeServer(server);
    }
});
