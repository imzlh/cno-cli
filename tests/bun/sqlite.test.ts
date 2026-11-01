import { deepStrictEqual, ok, strictEqual, throws } from 'node:assert';
import {
    Database,
    SQLiteError,
} from '../../cno/src/bun/sqlite/index.ts';

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
