import { match, ok, strictEqual, throws } from 'node:assert';
import { randomUUIDv7 } from 'node:crypto';
import { Readable } from 'node:stream';
import { bytes } from 'node:stream/consumers';
import { convertProcessSignalToExitCode } from 'node:util';
import { AsyncLocalStorage } from 'node:async_hooks';
import { constants as moduleConstants, enableCompileCache, getCompileCacheDir } from 'node:module';

Deno.test('node26: randomUUIDv7 encodes the timestamp and RFC 9562 fields', () => {
    const before = Date.now();
    const uuid = randomUUIDv7({ disableEntropyCache: true });
    const after = Date.now();

    match(uuid, /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    const timestamp = Number.parseInt(uuid.replaceAll('-', '').slice(0, 12), 16);
    ok(timestamp >= before && timestamp <= after);
    throws(() => randomUUIDv7({ disableEntropyCache: 'yes' as unknown as boolean }), TypeError);
});

Deno.test('node25: convertProcessSignalToExitCode uses POSIX signal exit status', () => {
    strictEqual(convertProcessSignalToExitCode('SIGTERM'), 143);
    strictEqual(convertProcessSignalToExitCode('SIGKILL'), 137);
    throws(
        () => convertProcessSignalToExitCode('SIG_NOT_REAL' as NodeJS.Signals),
        (error: unknown) => (error as Error & { code?: string }).code === 'ERR_INVALID_ARG_VALUE',
    );
});

Deno.test('node25: stream consumers bytes returns a plain Uint8Array', async () => {
    const value = await bytes(Readable.from(['node', Buffer.from('26')]));
    ok(value instanceof Uint8Array);
    strictEqual(Buffer.isBuffer(value), false);
    strictEqual(new TextDecoder().decode(value), 'node26');
});

Deno.test('node25: AsyncLocalStorage withScope restores the previous store', () => {
    const storage = new AsyncLocalStorage<string>();
    const other = new AsyncLocalStorage<string>();
    storage.run('outer', () => {
        const scope = storage.withScope('inner');
        strictEqual(storage.getStore(), 'inner');
        other.enterWith('preserved');
        scope.dispose();
        scope[Symbol.dispose]();
        strictEqual(storage.getStore(), 'outer');
        strictEqual(other.getStore(), 'preserved');
    });
});

Deno.test('node25: module compile cache accepts an options object', () => {
    const result = enableCompileCache({ directory: '/tmp/cno-node26-compile-cache', portable: true });
    strictEqual(result.status, moduleConstants.compileCacheStatus.ENABLED);
    strictEqual(result.directory, '/tmp/cno-node26-compile-cache');
    strictEqual(getCompileCacheDir(), result.directory);
    throws(
        () => enableCompileCache({ directory: 1 as unknown as string }),
        (error: unknown) => (error as Error & { code?: string }).code === 'ERR_INVALID_ARG_TYPE',
    );
});
