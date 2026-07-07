import { strictEqual, ok } from 'node:assert';
import { decodeUtf8 } from '../_helpers/bytes.ts';

// ============================================================================
// Web API — Storage (localStorage / sessionStorage)
// ============================================================================

const uniqueKey = (name: string) => `cno-storage-${Deno.pid}-${Date.now()}-${name}`;

const removeKey = (storage: Storage, key: string) => {
    storage.removeItem(key);
};

const runIsolatedStorageEval = async (source: string) => {
    const dir = Deno.makeTempDirSync({ prefix: 'cno-storage-' });
    try {
        const output = await new Deno.Command(Deno.execPath(), {
            args: ['eval', source],
            env: { CNO_STORAGE_DIR: dir },
        }).output();
        strictEqual(output.success, true, decodeUtf8(output.stderr));
        strictEqual(decodeUtf8(output.stdout), 'ok\n');
    } finally {
        Deno.removeSync(dir, { recursive: true });
    }
};

Deno.test('webapi: localStorage exists', () => {
    ok(typeof localStorage === 'object');
    ok(typeof localStorage.getItem === 'function');
    ok(typeof localStorage.setItem === 'function');
    ok(typeof localStorage.removeItem === 'function');
    ok(typeof localStorage.clear === 'function');
});

Deno.test('webapi: localStorage set/get round-trip', () => {
    const key = uniqueKey('round-trip');
    localStorage.setItem(key, 'value-1');
    strictEqual(localStorage.getItem(key), 'value-1');
    removeKey(localStorage, key);
});

Deno.test('webapi: localStorage getItem returns null for missing', () => {
    strictEqual(localStorage.getItem(uniqueKey('missing')), null);
});

Deno.test('webapi: localStorage removeItem removes', () => {
    const key = uniqueKey('remove');
    localStorage.setItem(key, 'value-2');
    localStorage.removeItem(key);
    strictEqual(localStorage.getItem(key), null);
});

Deno.test('webapi: localStorage clear removes all in an isolated storage directory', async () => {
    await runIsolatedStorageEval(`
        localStorage.setItem('test-key-a', 'a');
        localStorage.setItem('test-key-b', 'b');
        localStorage.clear();
        if (localStorage.length !== 0) throw new Error('clear did not empty storage');
        if (localStorage.getItem('test-key-a') !== null) throw new Error('test-key-a remained');
        if (localStorage.getItem('test-key-b') !== null) throw new Error('test-key-b remained');
        console.log('ok');
    `);
});

Deno.test('webapi: localStorage length property in an isolated storage directory', async () => {
    await runIsolatedStorageEval(`
        localStorage.clear();
        localStorage.setItem('k1', 'v1');
        localStorage.setItem('k2', 'v2');
        if (localStorage.length !== 2) throw new Error('unexpected length ' + localStorage.length);
        console.log('ok');
    `);
});

Deno.test('webapi: localStorage key() returns key at index in an isolated storage directory', async () => {
    await runIsolatedStorageEval(`
        localStorage.clear();
        localStorage.setItem('idx-key', 'val');
        if (localStorage.key(0) !== 'idx-key') throw new Error('unexpected key ' + localStorage.key(0));
        if (localStorage.key(1) !== null) throw new Error('out-of-range key should be null');
        console.log('ok');
    `);
});

Deno.test('webapi: sessionStorage exists and works', () => {
    const key = uniqueKey('session');
    ok(typeof sessionStorage === 'object');
    sessionStorage.setItem(key, 'sess-value');
    strictEqual(sessionStorage.getItem(key), 'sess-value');
    sessionStorage.removeItem(key);
});

Deno.test('webapi: localStorage and sessionStorage are independent', () => {
    const key = uniqueKey('shared');
    localStorage.setItem(key, 'local-value');
    sessionStorage.setItem(key, 'session-value');
    strictEqual(localStorage.getItem(key), 'local-value');
    strictEqual(sessionStorage.getItem(key), 'session-value');
    removeKey(localStorage, key);
    removeKey(sessionStorage, key);
});

Deno.test('webapi upstream: storage globals are assignable without replacing storage objects', () => {
    const local = globalThis.localStorage;
    const session = globalThis.sessionStorage;
    try {
        (globalThis as typeof globalThis & { localStorage: unknown }).localStorage = 1;
        (globalThis as typeof globalThis & { sessionStorage: unknown }).sessionStorage = 1;
        strictEqual(globalThis.localStorage, local);
        strictEqual(globalThis.sessionStorage, session);
        ok(globalThis.localStorage instanceof Storage);
        ok(globalThis.sessionStorage instanceof Storage);
    } finally {
        (globalThis as typeof globalThis & { localStorage: Storage }).localStorage = local;
        (globalThis as typeof globalThis & { sessionStorage: Storage }).sessionStorage = session;
    }
});

Deno.test('webapi upstream: storage proxy supports ordinary and symbol properties', async () => {
    await runIsolatedStorageEval(`
        localStorage.clear();
        localStorage.foo = 'foo';
        if (localStorage.foo !== 'foo') throw new Error('ordinary property did not round-trip');

        const symbol = Symbol('bar');
        localStorage[symbol] = 'bar';
        if (localStorage[symbol] !== 'bar') throw new Error('symbol property did not round-trip');
        if (!(symbol in localStorage)) throw new Error('symbol property missing from proxy');
        Object.getOwnPropertyDescriptor(localStorage, Symbol('missing'));
        console.log('ok');
    `);
});

Deno.test('webapi upstream: storage proxy hides implementation fields', async () => {
    await runIsolatedStorageEval(`
        localStorage.clear();
        const internalKeys = ['db', 'options', 'eventListeners', 'stmtCache', '_initialized'];

        for (const key of internalKeys) {
            if (key in localStorage) throw new Error('internal key leaked through has: ' + key);
            if (localStorage[key] !== undefined) throw new Error('internal key leaked through get: ' + key);
            if (Object.prototype.propertyIsEnumerable.call(localStorage, key)) {
                throw new Error('internal key leaked through descriptor: ' + key);
            }
        }

        const keys = Object.keys(localStorage);
        for (const key of internalKeys) {
            if (keys.includes(key)) throw new Error('internal key leaked through ownKeys: ' + key);
        }

        localStorage.db = 'stored';
        if (localStorage.db !== 'stored') throw new Error('storage key named db did not read back');
        if (localStorage.getItem('db') !== 'stored') throw new Error('storage key named db did not persist');
        if (!Object.keys(localStorage).includes('db')) throw new Error('storage key named db was hidden');
        localStorage.removeItem('db');
        console.log('ok');
    `);
});

Deno.test('webapi upstream: localStorage quota rejects oversize writes atomically', async () => {
    await runIsolatedStorageEval(`
        localStorage.clear();
        const bigValue = 'v'.repeat(11 * 1024 * 1024);
        const bigKey = 'k'.repeat(11 * 1024 * 1024);

        for (const [key, value, probe] of [
            ['k', bigValue, 'k'],
            [bigKey, 'v', bigKey],
            ['k'.repeat(5 * 1024 * 1024), 'v'.repeat(5 * 1024 * 1024), 'k'.repeat(5 * 1024 * 1024)],
        ]) {
            let rejected = false;
            try {
                localStorage.setItem(key, value);
            } catch (error) {
                rejected = true;
                if (!(error instanceof DOMException)) throw error;
                if (error.name !== 'QuotaExceededError') throw new Error('unexpected quota error name ' + error.name);
            }
            if (!rejected) throw new Error('oversize storage write was accepted');
            if (localStorage.getItem(probe) !== null) throw new Error('failed write stored data');
        }

        console.log('ok');
    `);
});
