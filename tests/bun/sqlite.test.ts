import { deepStrictEqual, ok, rejects, strictEqual, throws } from 'node:assert';
import vm from 'node:vm';
import {
    Database,
    SQLiteError,
    Statement,
} from '../../cno/src/bun/sqlite/index.ts';

Deno.test('bun:sqlite matches Bun constructor and exec alias shape', () => {
    deepStrictEqual(Object.getOwnPropertyDescriptor(Database, 'length'), {
        value: 2,
        writable: false,
        enumerable: false,
        configurable: true,
    });
    deepStrictEqual(Object.getOwnPropertyDescriptor(Statement, 'length'), {
        value: 1,
        writable: false,
        enumerable: false,
        configurable: true,
    });
    strictEqual(Database.open.length, 2);
    strictEqual(Database.prototype.transaction.length, 2);
    deepStrictEqual(Object.getOwnPropertyDescriptor(Database.prototype, 'exec'), {
        value: Database.prototype.run,
        writable: true,
        enumerable: true,
        configurable: true,
    });

    const db = Reflect.construct(Database, [':memory:', null]) as Database;
    try {
        strictEqual(db.filename, ':memory:');
    } finally {
        db.close();
    }
});

Deno.test('bun:sqlite exposes Statement execution methods as own enumerable fields', () => {
    const db = new Database(':memory:');
    const statement = db.prepare<{ value: number }>('SELECT ? AS value');
    const other = db.prepare<{ value: number }>('SELECT ? AS value');
    const methods = ['get', 'all', 'iterate', 'values', 'raw', 'run'] as const;
    try {
        deepStrictEqual(Reflect.ownKeys(statement), methods);
        deepStrictEqual(Object.keys(statement), methods);
        for (const method of methods) {
            deepStrictEqual(Object.getOwnPropertyDescriptor(statement, method), {
                value: statement[method],
                writable: true,
                enumerable: true,
                configurable: true,
            });
            strictEqual(Object.getOwnPropertyDescriptor(Statement.prototype, method), undefined);
            strictEqual(statement[method], other[method]);
        }

        deepStrictEqual(statement.get.call(other, 7), { value: 7 });
    } finally {
        statement.finalize();
        other.finalize();
        db.close();
    }
});

Deno.test('bun:sqlite runs statements and preserves binding types', () => {
    const db = new Database(':memory:');
    try {
        deepStrictEqual(db.run('CREATE TABLE items (id INTEGER PRIMARY KEY, name TEXT, data BLOB)'), {
            changes: 0,
            lastInsertRowid: 0,
        });

        const buffer = new Uint8Array([0, 0x61, 0x62, 0]);
        const view = new Uint8Array(buffer.buffer, 1, 2);
        deepStrictEqual(db.run('INSERT INTO items (name, data) VALUES (?, ?)', 'one', view), {
            changes: 1,
            lastInsertRowid: 1,
        });

        const second = db.prepare('INSERT INTO items (name, data) VALUES ($name, $data)');
        try {
            deepStrictEqual(second.run({ name: 'two', data: new Uint8Array([3, 4]) }), {
                changes: 1,
                lastInsertRowid: 2,
            });
        } finally {
            second.finalize();
        }

        const query = db.query<{ id: number; name: string; hex: string }>(
            'SELECT id, name, hex(data) AS hex FROM items ORDER BY id',
        );
        strictEqual(query.reader, true);
        strictEqual(query.readonly, true);
        deepStrictEqual(query.columnNames, ['id', 'name', 'hex']);
        deepStrictEqual(query.all(), [
            { id: 1, name: 'one', hex: '6162' },
            { id: 2, name: 'two', hex: '0304' },
        ]);
        deepStrictEqual(query.values(), [
            [1, 'one', '6162'],
            [2, 'two', '0304'],
        ]);
        deepStrictEqual([...query.iterate()], query.all());
        deepStrictEqual(db.query<{ id: number; name: string; data: Uint8Array }>(
            'SELECT * FROM items WHERE id = ?',
        ).get(99), null);
    } finally {
        db.close();
    }
});

Deno.test('bun:sqlite recognizes BLOBs by binary internal slots', () => {
    const db = new Database(':memory:');
    const statement = db.query<{ hex: string }>('SELECT hex(?) AS hex');
    const blobHex = (value: unknown) => statement.get([value])?.hex;
    const originalIsView = ArrayBuffer.isView;
    try {
        const shared = new SharedArrayBuffer(2);
        new Uint8Array(shared).set([5, 6]);
        strictEqual(blobHex(Uint8Array.of(1, 2).buffer), '0102');
        strictEqual(blobHex(new DataView(Uint8Array.of(0, 3, 4).buffer, 1, 2)), '0304');
        strictEqual(blobHex(shared), '0506');

        const context = vm.createContext({});
        strictEqual(blobHex(vm.runInContext('new Uint8Array([7, 8])', context)), '0708');
        strictEqual(blobHex(vm.runInContext('Uint8Array.of(9, 10).buffer', context)), '090A');
        strictEqual(blobHex(vm.runInContext(`
            (() => {
                const value = new SharedArrayBuffer(2);
                new Uint8Array(value).set([11, 12]);
                return value;
            })()
        `, context)), '0B0C');

        const shadowed = Uint8Array.of(13, 14);
        Object.defineProperties(shadowed, {
            buffer: { get: () => { throw new Error('read shadowed buffer'); } },
            byteOffset: { get: () => { throw new Error('read shadowed byteOffset'); } },
            byteLength: { get: () => { throw new Error('read shadowed byteLength'); } },
        });
        strictEqual(blobHex(shadowed), '0D0E');

        ArrayBuffer.isView = (() => false) as typeof ArrayBuffer.isView;
        strictEqual(blobHex(Uint8Array.of(15, 16)), '0F10');
        ArrayBuffer.isView = (() => { throw new Error('replacement called'); }) as typeof ArrayBuffer.isView;
        throws(() => blobHex({}), /Binding|primitive|binary|TypedArray/);

        const detachedView = Uint8Array.of(17, 18);
        const detachedBuffer = detachedView.buffer;
        structuredClone(detachedBuffer, { transfer: [detachedBuffer] });
        strictEqual(blobHex(detachedView), '');
        strictEqual(blobHex(detachedBuffer), '');

        const resizable = new ArrayBuffer(4, { maxByteLength: 8 });
        const outOfBounds = new DataView(resizable, 2, 2);
        resizable.resize(1);
        strictEqual(blobHex(outOfBounds), '');

        throws(() => blobHex(new Proxy(Uint8Array.of(19, 20), {})), /Binding|primitive|binary|TypedArray/);

        db.run('CREATE TABLE copied (value BLOB)');
        const source = Uint8Array.of(21, 22);
        const insert = db.prepare('INSERT INTO copied VALUES (?)', [source]);
        source.set([99, 99]);
        insert.run();
        strictEqual(db.query<{ hex: string }>('SELECT hex(value) AS hex FROM copied').get()?.hex, '1516');
        insert.finalize();
    } finally {
        ArrayBuffer.isView = originalIsView;
        db.close();
    }
});

Deno.test('bun:sqlite matches Bun named and positional binding rules', () => {
    const db = new Database(':memory:');
    try {
        strictEqual(db.query<{ value: number | null }>('SELECT ? AS value').get()?.value, null);
        strictEqual(db.query<{ value: number | null }>('SELECT ? AS value').get([])?.value, null);
        strictEqual(db.query('SELECT ? AS value').get(7)?.value, 7);
        throws(
            () => db.query('SELECT ? AS value').get([7, 8]),
            /SQLite query expected 1 values, received 2/,
        );
        throws(
            () => db.query('SELECT ? AS value, ? AS other').get([7]),
            /SQLite query expected 2 values, received 1/,
        );

        strictEqual(db.query('SELECT $name AS value').get({ name: 'bare' })?.value, 'bare');
        strictEqual(db.query('SELECT $name AS value').get({ $name: 'prefixed' })?.value, 'prefixed');
        strictEqual(db.query('SELECT $name AS value').get({ name: 'bare', $name: 'prefixed' })?.value, 'prefixed');
        strictEqual(db.query('SELECT $name AS value').get({ typo: 'ignored' })?.value, null);

        const strictDb = new Database(':memory:', { strict: true });
        try {
            strictEqual(strictDb.query('SELECT $name AS value').get({ name: 'present' })?.value, 'present');
            strictEqual(strictDb.query('SELECT $name AS value').get({ name: 'bare', $name: 'prefixed' })?.value, 'bare');
            strictEqual(strictDb.query('SELECT $name AS value').get({ name: 'present', typo: 'ignored' })?.value, 'present');
            throws(
                () => strictDb.query('SELECT $name AS value').get({ typo: 'missing' }),
                /Missing parameter "name"/,
            );
            throws(
                () => strictDb.query('SELECT ? AS value').get({ value: 1 }),
                /Missing parameter "\?1"/,
            );
        } finally {
            strictDb.close();
        }
    } finally {
        db.close();
    }
});

Deno.test('bun:sqlite safeIntegers controls rows, results, and overflow binding', () => {
    const value = 9_007_199_254_740_993n;
    const db = new Database(':memory:');
    try {
        db.run('CREATE TABLE values_table (value INTEGER)');
        db.run('INSERT INTO values_table VALUES (?)', value);
        strictEqual(db.query('SELECT value FROM values_table').get()?.value, Number(value));

        const safe = db.query('SELECT value FROM values_table').safeIntegers(true);
        strictEqual(safe.get()?.value, value);
        deepStrictEqual(db.run('INSERT INTO values_table VALUES (?)', (1n << 64n) + 5n), {
            changes: 1,
            lastInsertRowid: 2,
        });
        strictEqual(db.query('SELECT value FROM values_table ORDER BY rowid').all()[1]?.value, 5);
    } finally {
        db.close();
    }

    const safeDb = new Database(':memory:', { safeIntegers: true });
    try {
        safeDb.run('CREATE TABLE values_table (value INTEGER)');
        throws(
            () => safeDb.run('INSERT INTO values_table VALUES (?)', 1n << 64n),
            /out of range/,
        );
        deepStrictEqual(safeDb.run('INSERT INTO values_table VALUES (?)', 4n), {
            changes: 1,
            lastInsertRowid: 1n,
        });
    } finally {
        safeDb.close();
    }
});

Deno.test('bun:sqlite safeIntegers coerces setters and rejects finalized statements', () => {
    const db = new Database(':memory:');
    const statement = db.query('SELECT 1 AS value');
    try {
        strictEqual(statement.safeIntegers(), false);
        strictEqual(statement.safeIntegers('enabled' as unknown as boolean), statement);
        strictEqual(statement.safeIntegers(), true);
        strictEqual(statement.safeIntegers(0 as unknown as boolean), statement);
        strictEqual(statement.safeIntegers(), false);

        statement.finalize();
        throws(() => statement.safeIntegers(), /Statement has finalized/);
        throws(
            () => statement.safeIntegers('enabled' as unknown as boolean),
            /Statement has finalized/,
        );
        throws(() => statement.columnTypes, /Statement has finalized/);
        throws(() => statement.raw(), /Statement has finalized/);
    } finally {
        statement.finalize();
        db.close();
    }
});

Deno.test('bun:sqlite iterate defers finalized-state errors until iteration begins', () => {
    const db = new Database(':memory:');
    const statement = db.prepare('SELECT 1 AS value');
    statement.finalize();

    const finalizedIterator = statement.iterate();
    throws(() => finalizedIterator.next(), /Statement has finalized/);
    deepStrictEqual(finalizedIterator.next(), { done: true, value: undefined });
    db.close();

    const closedDb = new Database(':memory:');
    const closedStatement = closedDb.query('SELECT 1 AS value');
    closedDb.close();

    const closedIterator = closedStatement.iterate();
    throws(() => closedIterator.next(), /Database has closed/);
    deepStrictEqual(closedIterator.next(), { done: true, value: undefined });
});

Deno.test('bun:sqlite transactions commit, roll back, and nest with savepoints', () => {
    const db = new Database(':memory:');
    try {
        db.run('CREATE TABLE events (value INTEGER)');
        let enteredTransaction = false;
        const add = db.transaction((value: number) => {
            enteredTransaction = db.inTransaction;
            db.run('INSERT INTO events VALUES (?)', value);
            return value * 2;
        });

        strictEqual(add(1), 2);
        strictEqual(enteredTransaction, true);
        strictEqual(db.inTransaction, false);
        strictEqual(add.immediate(2), 4);

        const rollback = db.transaction(() => {
            db.run('INSERT INTO events VALUES (3)');
            throw new Error('rollback me');
        });
        throws(() => rollback(), /rollback me/);

        const inner = db.transaction(() => {
            db.run('INSERT INTO events VALUES (5)');
            throw new Error('inner rollback');
        });
        const outer = db.transaction(() => {
            db.run('INSERT INTO events VALUES (4)');
            try {
                inner();
            } catch (error) {
                strictEqual((error as Error).message, 'inner rollback');
            }
            db.run('INSERT INTO events VALUES (6)');
        });
        outer.deferred();

        deepStrictEqual(db.query('SELECT value FROM events ORDER BY value').all(), [
            { value: 1 },
            { value: 2 },
            { value: 4 },
            { value: 6 },
        ]);
    } finally {
        db.close();
    }
});

Deno.test('bun:sqlite transaction modes preserve receivers and decide promise outcomes synchronously', async () => {
    const db = new Database(':memory:');
    try {
        db.run('CREATE TABLE events (value INTEGER)');
        const receiver = { offset: 10 };
        const insert = db.transaction(function(this: typeof receiver, value: number) {
            db.run('INSERT INTO events VALUES (?)', value + this.offset);
            return this;
        });
        for (const [index, transaction] of [insert, insert.deferred, insert.immediate, insert.exclusive].entries()) {
            strictEqual(transaction.call(receiver, index), receiver);
            strictEqual(transaction.default, insert);
            strictEqual(transaction.database, db);
        }

        const failure = new Error('rejected before commit');
        const rejection = Promise.reject(failure);
        void rejection.catch(() => {});
        const rejected = db.transaction(() => {
            db.run('INSERT INTO events VALUES (20)');
            return rejection;
        });
        for (const transaction of [rejected, rejected.deferred, rejected.immediate, rejected.exclusive]) {
            strictEqual(transaction(), rejection);
            strictEqual(db.inTransaction, false);
        }
        await rejects(rejection, error => error === failure);
        for (const reason of [null, undefined]) {
            const primitiveRejection = Promise.reject(reason);
            void primitiveRejection.catch(() => {});
            strictEqual(db.transaction(() => {
                db.run('INSERT INTO events VALUES (21)');
                return primitiveRejection;
            })(), primitiveRejection);
            await rejects(primitiveRejection, error => error === reason);
        }
        deepStrictEqual(db.query('SELECT value FROM events').values(), [[10], [11], [12], [13]]);

        db.transaction(() => {
            db.run('INSERT INTO events VALUES (30)');
            strictEqual(rejected(), rejection);
            strictEqual(db.inTransaction, true);
            db.run('INSERT INTO events VALUES (31)');
        })();

        const fulfilled = Promise.resolve(null);
        strictEqual(db.transaction(() => {
            db.run('INSERT INTO events VALUES (39)');
            return fulfilled;
        })(), fulfilled);
        let release!: () => void;
        const pending = new Promise<void>(resolve => { release = resolve; });
        const result = db.transaction(async () => {
            db.run('INSERT INTO events VALUES (40)');
            await pending;
            db.run('INSERT INTO events VALUES (41)');
            throw failure;
        })();
        strictEqual(db.inTransaction, false);
        deepStrictEqual(db.query('SELECT value FROM events').values(), [[10], [11], [12], [13], [30], [31], [39], [40]]);
        release();
        await rejects(result, error => error === failure);
        deepStrictEqual(db.query('SELECT value FROM events').values(), [[10], [11], [12], [13], [30], [31], [39], [40], [41]]);

        const thenable = { get then(): never { throw new Error('unexpected thenable access'); } };
        strictEqual(db.transaction(() => thenable)(), thenable);
        for (const control of ['COMMIT', 'ROLLBACK']) {
            strictEqual(db.transaction(() => {
                db.run(control);
                return rejection;
            })(), rejection);
            strictEqual(db.inTransaction, false);
        }
    } finally {
        db.close();
    }
});

Deno.test('bun:sqlite keeps CREATE TRIGGER bodies intact in multi-statement run', () => {
    const db = new Database(':memory:');
    try {
        db.run(`
            CREATE TABLE source (id INTEGER PRIMARY KEY, value TEXT);
            CREATE TABLE audit (kind TEXT, payload TEXT);
        `);

        deepStrictEqual(db.run(`
            CREATE TEMP TRIGGER source_audit AFTER INSERT ON source
            BEGIN
                INSERT INTO audit VALUES ('first;kind', NEW.value);
                -- This semicolon is inside the trigger body, not a top-level delimiter.
                INSERT INTO audit VALUES (
                    CASE WHEN NEW.value = 'created' THEN 'second' ELSE 'other' END,
                    NEW.value || ';tail'
                );
            END;
            INSERT INTO source(value) VALUES ('created');
        `), {
            changes: 1,
            lastInsertRowid: 1,
        });

        deepStrictEqual(db.query('SELECT kind, payload FROM audit ORDER BY rowid').all(), [
            { kind: 'first;kind', payload: 'created' },
            { kind: 'second', payload: 'created;tail' },
        ]);
    } finally {
        db.close();
    }
});

Deno.test('bun:sqlite rejects blank prepare and query without leaking native statements', () => {
    const db = new Database(':memory:');
    for (const sql of [' ', '-- only a comment', '/* only a block comment */', ';;']) {
        throws(() => db.prepare(sql), RangeError);
        throws(() => db.query(sql), RangeError);
    }
    throws(() => db.prepare(''), /Invalid SQL statement/);
    throws(() => db.query(''), /SQL query cannot be empty/);

    // throwOnError uses the immediate-close path. It would fail if any blank
    // native statement had been retained in the outstanding statement set.
    db.close(true);
});

Deno.test('bun:sqlite cache eviction remains usable but closes with its database', () => {
    const previousLimit = Database.MAX_QUERY_CACHE_SIZE;
    Database.MAX_QUERY_CACHE_SIZE = 1;
    try {
        const db = new Database(':memory:');
        const evicted = db.query<{ value: number }>('SELECT 1 AS value');
        const cached = db.query<{ value: number }>('SELECT 2 AS value');

        strictEqual(evicted.isFinalized, false);
        deepStrictEqual(evicted.get(), { value: 1 });
        strictEqual(db.query('SELECT 2 AS value'), cached);

        db.clearQueryCache();
        strictEqual(evicted.isFinalized, false);
        strictEqual(cached.isFinalized, true);
        deepStrictEqual(evicted.get(), { value: 1 });

        db.close();
        strictEqual(evicted.isFinalized, true);
        strictEqual(cached.isFinalized, true);
        throws(() => evicted.get(), /Database has closed/);
    } finally {
        Database.MAX_QUERY_CACHE_SIZE = previousLimit;
    }
});

Deno.test('bun:sqlite close keeps prepared statements alive and finalizes queries', () => {
    const db = new Database(':memory:');
    const prepared = db.prepare('SELECT ? AS value');
    const cached = db.query('SELECT 2 AS value');
    try {
        strictEqual(db.query('SELECT 2 AS value'), cached);
        db.close();
        deepStrictEqual(prepared.get(3), { value: 3 });
        strictEqual(cached.isFinalized, true);
        throws(() => cached.get(), /Database has closed/);
        throws(() => db.query('SELECT 1'), /Database has closed/);
        db.close();
    } finally {
        prepared.finalize();
    }

    const forceClosed = new Database(':memory:');
    const forcePrepared = forceClosed.prepare('SELECT 1');
    forceClosed.close(true);
    strictEqual(forcePrepared.isFinalized, true);
    throws(() => forcePrepared.get(), /Database has closed/);
    forceClosed.close();
});

Deno.test('bun:sqlite reports SQLite errors with Bun fields', () => {
    const db = new Database(':memory:');
    try {
        db.run('CREATE TABLE unique_values (value TEXT UNIQUE)');
        db.run('INSERT INTO unique_values VALUES (?)', 'same');
        let caught: unknown;
        try {
            db.run('INSERT INTO unique_values VALUES (?)', 'same');
        } catch (error) {
            caught = error;
        }
        ok(caught instanceof SQLiteError);
        strictEqual((caught as SQLiteError).name, 'SQLiteError');
        strictEqual((caught as SQLiteError).code, 'SQLITE_CONSTRAINT_UNIQUE');
        strictEqual((caught as SQLiteError).errno, 2067);
        strictEqual((caught as SQLiteError).byteOffset, -1);
    } finally {
        db.close();
    }
});

Deno.test('bun:sqlite ignores whitespace-separated trailing comments in run', () => {
    const db = new Database(':memory:');
    try {
        deepStrictEqual(db.run('CREATE TABLE t (x);\n  -- one\n  -- two\n  /* three */\n'), {
            changes: 0,
            lastInsertRowid: 0,
        });
        throws(() => db.run('-- a\n  /* b */'), /no valid SQL statement/);
    } finally {
        db.close();
    }
});

Deno.test('bun:sqlite maps extended SQLite errnos to the matching code names', () => {
    // Values from sqlite3.h: primary code | (extension << 8).
    const expected: Array<[number, string]> = [
        [261, 'SQLITE_BUSY_RECOVERY'],
        [517, 'SQLITE_BUSY_SNAPSHOT'],
        [773, 'SQLITE_BUSY_TIMEOUT'],
        [262, 'SQLITE_LOCKED_SHAREDCACHE'],
        [264, 'SQLITE_READONLY_RECOVERY'],
        [270, 'SQLITE_CANTOPEN_NOTEMPDIR'],
    ];
    for (const [errno, code] of expected) {
        strictEqual(new SQLiteError('x', errno).code, code);
    }
});
