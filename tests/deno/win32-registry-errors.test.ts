import { ok, strictEqual, throws } from 'node:assert';

const win32 = import.meta.use('win32');
const errors = import.meta.use('error').errno;
const tcpipKey = 'SYSTEM\\CurrentControlSet\\Services\\Tcpip\\Parameters';
const missingKey = `Software\\CnoMissingRegistryKey-${Deno.pid}-${Date.now()}`;

Deno.test({ name: 'win32 registry: predefined HKLM handles work on 64-bit Windows', ignore: !win32 }, () => {
    ok(win32);
    const hostname = win32.readRegistry(win32.HKLM, tcpipKey, 'Hostname');
    strictEqual(typeof hostname, 'string');
    strictEqual(win32.readRegistry(win32.HKLM >>> 0, tcpipKey, 'Hostname'), hostname);
});

Deno.test({ name: 'win32 registry: missing keys and values throw catchable ENOENT', ignore: !win32 }, () => {
    ok(win32);
    for (const [key, name] of [[missingKey, 'missing'], [tcpipKey, `CnoMissingValue-${Deno.pid}`]]) {
        throws(() => win32.readRegistry(win32.HKLM, key, name), (error: unknown) => {
            ok(error instanceof Error);
            strictEqual(error.name, 'IOError');
            strictEqual(Reflect.get(error, 'code'), errors.ENOENT);
            return true;
        });
    }
});

Deno.test({ name: 'win32 registry: write, delete and watch errors remain catchable', ignore: !win32 }, () => {
    ok(win32);
    for (const operation of [
        () => win32.writeRegistry(win32.HKCU, missingKey, 'missing', 'unused'),
        () => win32.delRegistry(win32.HKCU, missingKey, 'missing'),
        () => win32.watchRegistry(win32.HKCU, missingKey, () => {}),
    ]) {
        throws(operation, (error: unknown) => {
            ok(error instanceof Error);
            strictEqual(Reflect.get(error, 'code'), errors.ENOENT);
            return true;
        });
    }
});

Deno.test({ name: 'win32 registry: zero handles throw a catchable error', ignore: !win32 }, () => {
    ok(win32);
    throws(() => win32.readRegistry(0, tcpipKey, 'Hostname'), (error: unknown) => {
        ok(error instanceof Error);
        strictEqual(Reflect.get(error, 'code'), errors.EBADF);
        return true;
    });
});
