import { ok, strictEqual } from 'node:assert';

// xterm-headless treats `typeof navigator !== "undefined"` as browser and then
// does `"requestIdleCallback" in window`. cno has navigator but keeps
// `window` undefined (Deno main-thread parity), so install a minimal object
// for the `in` check without reintroducing a real browser window.
async function withBrowserishWindow<T>(fn: () => Promise<T>): Promise<T> {
    const g = globalThis as typeof globalThis & { window?: unknown };
    const had = Object.prototype.hasOwnProperty.call(g, 'window');
    const prev = g.window;
    g.window = Object.create(null);
    try {
        return await fn();
    } finally {
        if (had) g.window = prev;
        else delete g.window;
    }
}

Deno.test({ name: 'xterm-headless: applies cursor movement and SGR state', timeout: 60000 }, async () => {
    await withBrowserishWindow(async () => {
        const mod = await import('npm:xterm-headless');
        const Terminal = mod.Terminal ?? mod.default?.Terminal;
        const term = new Terminal({ cols: 10, rows: 3, allowProposedApi: true });

        await new Promise<void>((resolve) => term.write('abc\u001b[2DXY\r\n\u001b[31mred\u001b[0m', resolve));

        strictEqual(term.buffer.active.getLine(0)?.translateToString(true), 'aXY');
        strictEqual(term.buffer.active.getLine(1)?.translateToString(true), 'red');
        strictEqual(term.buffer.active.getLine(1)?.getCell(0)?.isFgDefault(), false);
    });
});

Deno.test({ name: 'xterm-headless: terminal buffer updates on input', timeout: 60000 }, async () => {
    await withBrowserishWindow(async () => {
        const mod = await import('npm:xterm-headless');
        const Terminal = mod.Terminal ?? mod.default?.Terminal;
        const term = new Terminal({ cols: 20, rows: 5, allowProposedApi: true });
        await new Promise<void>((resolve) => term.write('hello\r\nworld', resolve));

        strictEqual(term.buffer.active.getLine(0)?.translateToString(true), 'hello');
        strictEqual(term.buffer.active.getLine(1)?.translateToString(true), 'world');
    });
});

Deno.test({ name: 'zod and superstruct: runtime validators execute', timeout: 30000 }, async () => {
    const zod = await import('npm:zod');
    const superstruct = await import('npm:superstruct');

    const zUser = zod.z.object({ name: zod.z.string(), age: zod.z.number().int().positive() });
    strictEqual(zUser.parse({ name: 'cno', age: 1 }).name, 'cno');

    const sUser = superstruct.object({
        name: superstruct.string(),
        age: superstruct.number(),
    });
    const [err, value] = superstruct.validate({ name: 'cno', age: 2 }, sUser);
    strictEqual(err, undefined);
    strictEqual(value?.age, 2);
});

Deno.test({ name: 'sql.js: wasm sqlite executes a query', timeout: 30000 }, async () => {
    const mod = await import('npm:sql.js');
    const initSqlJs = mod.default ?? mod;
    const wasmPath = require.resolve('sql.js/dist/sql-wasm.wasm');
    const SQL = await initSqlJs({ locateFile: () => wasmPath });
    const db = new SQL.Database();
    db.run('CREATE TABLE t (name TEXT, value INTEGER)');
    db.run('INSERT INTO t VALUES (?, ?)', ['answer', 42]);
    const rows = db.exec('SELECT value FROM t WHERE name = ?', ['answer']);

    strictEqual(rows[0]?.values[0]?.[0], 42);
    db.close();
});

Deno.test({ name: 'localforage: reports a usable storage driver or a clear unsupported error', timeout: 30000 }, async () => {
    const mod = await import('npm:localforage');
    const localforage = mod.default ?? mod;
    try {
        await localforage.setItem('cno-key', 'value');
        strictEqual(await localforage.getItem('cno-key'), 'value');
    } catch (e) {
        ok(e instanceof Error);
        ok(/No available storage method|indexedDB|localStorage|driver/i.test(e.message), e.message);
    }
});
