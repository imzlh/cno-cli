import { deepStrictEqual, ok, rejects, strictEqual, throws } from 'node:assert';

Deno.test('deno.permissions: async and sync methods return stable granted status', async () => {
    const desc = { name: 'read' } as Deno.PermissionDescriptor;
    const queried = await Deno.permissions.query(desc);
    const queriedSync = Deno.permissions.querySync(desc);
    const requested = await Deno.permissions.request(desc);
    const requestedSync = Deno.permissions.requestSync(desc);
    const revoked = await Deno.permissions.revoke(desc);
    const revokedSync = Deno.permissions.revokeSync(desc);

    for (const status of [queried, queriedSync, requested, requestedSync, revoked, revokedSync]) {
        ok(status instanceof Deno.PermissionStatus);
        strictEqual(status.state, 'granted');
        strictEqual(status.partial, false);
        strictEqual(typeof status.addEventListener, 'function');
    }
    strictEqual(queried, queriedSync);
    strictEqual(queried, requested);
    strictEqual(queried, revokedSync);
});

Deno.test('deno.permissions: invalid descriptors reject before returning granted status', async () => {
    for (const value of [undefined, null, {}, { name: 'bad' }]) {
        await rejects(() => Deno.permissions.query(value as Deno.PermissionDescriptor), TypeError);
        throws(() => Deno.permissions.querySync(value as Deno.PermissionDescriptor), TypeError);
        await rejects(() => Deno.permissions.request(value as Deno.PermissionDescriptor), TypeError);
        throws(() => Deno.permissions.requestSync(value as Deno.PermissionDescriptor), TypeError);
        await rejects(() => Deno.permissions.revoke(value as Deno.PermissionDescriptor), TypeError);
        throws(() => Deno.permissions.revokeSync(value as Deno.PermissionDescriptor), TypeError);
    }

    await rejects(() => Deno.permissions.query({ name: 'net', host: ':' }), URIError);
    throws(() => Deno.permissions.querySync({ name: 'net', host: ':' }), URIError);
    await rejects(() => Deno.permissions.query({ name: 'sys', kind: 'missing' as 'loadavg' }), TypeError);
    throws(() => Deno.permissions.querySync({ name: 'sys', kind: 'missing' as 'loadavg' }), TypeError);
});

Deno.test('deno.permissions: descriptor identity follows normalized descriptor scope', async () => {
    const readA = await Deno.permissions.query({ name: 'read', path: '.' });
    const readB = Deno.permissions.querySync({ name: 'read', path: '.' });
    strictEqual(readA, readB);

    const envA = await Deno.permissions.query({ name: 'env', variable: 'A' });
    const envB = await Deno.permissions.query({ name: 'env', variable: 'B' });
    ok(envA !== envB);

    const url = new URL('.', import.meta.url);
    strictEqual(
        await Deno.permissions.query({ name: 'read', path: url }),
        Deno.permissions.querySync({ name: 'read', path: url }),
    );

    await Deno.permissions.query({ name: 'sys', kind: 'loadavg' });
    Deno.permissions.querySync({ name: 'sys', kind: 'networkInterfaces' });
    await Deno.permissions.query({ name: 'import', host: 'jsr.io:443' } as Deno.PermissionDescriptor);
});

Deno.test('deno.permissions: official sys and path-like descriptors validate', async () => {
    for (const kind of [
        'loadavg',
        'osRelease',
        'osUptime',
        'networkInterfaces',
        'systemMemoryInfo',
        'hostname',
        'uid',
        'gid',
        'cpus',
        'homedir',
        'statfs',
        'getPriority',
        'setPriority',
        'ca',
    ] as const) {
        strictEqual((await Deno.permissions.query({ name: 'sys', kind })).state, 'granted');
        strictEqual(Deno.permissions.querySync({ name: 'sys', kind }).state, 'granted');
    }

    const url = new URL('.', import.meta.url);
    strictEqual((await Deno.permissions.query({ name: 'read', path: url })).state, 'granted');
    strictEqual((await Deno.permissions.query({ name: 'write', path: url })).state, 'granted');
    strictEqual((await Deno.permissions.query({ name: 'ffi', path: url })).state, 'granted');
    strictEqual((await Deno.permissions.query({ name: 'run', command: url })).state, 'granted');
});

Deno.test('deno.permissions: PermissionStatus onchange is writable', () => {
    const status = Deno.permissions.querySync({ name: 'env' } as Deno.PermissionDescriptor);
    status.onchange = () => {};
    strictEqual(typeof status.onchange, 'function');
    status.onchange = null;
    strictEqual(status.onchange, null);
});

Deno.test('deno.permissions: PermissionStatus dispatches EventTarget listeners and onchange', () => {
    const status = Deno.permissions.querySync({ name: 'env' } as Deno.PermissionDescriptor);
    const controller = new AbortController();
    const calls: string[] = [];
    const removed = () => calls.push('removed');
    const aborted = () => calls.push('aborted');

    status.addEventListener('change', () => calls.push('once'), { once: true });
    status.addEventListener('change', removed);
    status.removeEventListener('change', removed);
    status.addEventListener('change', aborted, { signal: controller.signal });
    controller.abort();
    status.onchange = function (event) {
        strictEqual(this, status);
        strictEqual(event.type, 'change');
        calls.push('onchange');
    };

    strictEqual(status.dispatchEvent(new Event('change')), true);
    strictEqual(status.dispatchEvent(new Event('change')), true);
    strictEqual(status.dispatchEvent(new Event('ignored')), true);
    strictEqual(status.dispatchEvent(new Event('cancelable', { cancelable: true })), true);
    strictEqual(Object.prototype.toString.call(status), '[object PermissionStatus]');
    deepStrictEqual(calls, ['once', 'onchange', 'onchange']);

    status.onchange = null;
});

Deno.test('deno.permissions: Permissions and PermissionStatus constructors expose native-style shape', () => {
    strictEqual(typeof Deno.Permissions, 'function');
    strictEqual(typeof Deno.PermissionStatus, 'function');
    ok(Deno.permissions instanceof Deno.Permissions);
    ok(Deno.permissions.querySync({ name: 'read' }) instanceof Deno.PermissionStatus);
    strictEqual(Deno.Permissions.length, 0);
    strictEqual(Deno.PermissionStatus.length, 0);
    strictEqual(Object.prototype.toString.call(Deno.permissions), '[object Permissions]');
    throws(() => new (Deno.Permissions as unknown as new () => Deno.Permissions)(), TypeError);
    throws(() => new (Deno.PermissionStatus as unknown as new () => Deno.PermissionStatus)(), TypeError);
});

Deno.test('deno.errors: exported constructors cover common filesystem and network names', () => {
    const names = [
        'NotFound',
        'PermissionDenied',
        'ConnectionRefused',
        'ConnectionReset',
        'ConnectionAborted',
        'NotConnected',
        'AddrInUse',
        'AddrNotAvailable',
        'BrokenPipe',
        'AlreadyExists',
        'InvalidData',
        'TimedOut',
        'Interrupted',
        'WriteZero',
        'WouldBlock',
        'UnexpectedEof',
        'BadResource',
        'Http',
        'Busy',
        'NotSupported',
        'FilesystemLoop',
        'IsADirectory',
        'NetworkUnreachable',
        'NotADirectory',
        'NotCapable',
    ];

    for (const name of names) {
        const Ctor = (Deno.errors as Record<string, new (message: string, options?: { cause?: unknown }) => Error>)[name];
        ok(typeof Ctor === 'function', `Deno.errors.${name} must exist`);
        const cause = { source: name };
        const err = new Ctor(`${name}-message`, { cause });
        ok(err instanceof Error);
        ok(err instanceof Ctor);
        strictEqual(err.name, name);
        strictEqual(err.message, `${name}-message`);
        strictEqual(err.cause, cause);
    }
});
