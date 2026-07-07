import { deepStrictEqual, strictEqual, ok, throws } from 'node:assert';

// ============================================================================
// sqlite (not sqlite3) — newer node:sqlite experimental API
// ============================================================================

Deno.test('sqlite: module loads', () => {
    const sqlite = require('node:sqlite');
    ok(typeof sqlite === 'object');
    ok(typeof sqlite.DatabaseSync === 'function');
    ok(typeof sqlite.StatementSync === 'function');
    ok(typeof sqlite.backup === 'function');
    ok(typeof sqlite.constants === 'object');
});

Deno.test('sqlite: DatabaseSync is constructor', () => {
    const { DatabaseSync, StatementSync } = require('node:sqlite');
    ok(typeof DatabaseSync === 'function');
    ok(typeof StatementSync === 'function');
});

Deno.test('sqlite: constants expose stable numeric changeset codes', () => {
    const { constants } = require('node:sqlite');
    strictEqual(constants.SQLITE_CHANGESET_OMIT, 0);
    strictEqual(constants.SQLITE_CHANGESET_REPLACE, 1);
    strictEqual(constants.SQLITE_CHANGESET_ABORT, 2);
});

Deno.test('sqlite: DatabaseSync constructor accepts path', () => {
    const { DatabaseSync } = require('node:sqlite');
    // Open in-memory database
    const db = new DatabaseSync(':memory:');
    ok(typeof db === 'object');
    ok(typeof db.exec === 'function');
    ok(typeof db.prepare === 'function');
    db.close();
});

Deno.test('sqlite upstream: DatabaseSync accepts Buffer and file URL paths', () => {
    const { DatabaseSync } = require('node:sqlite');
    const dir = Deno.makeTempDirSync({ prefix: 'cno-sqlite-paths-' });
    const bufferPath = `${dir}/buffer-path.db`;
    const urlPath = `${dir}/url-path.db`;
    try {
        const bufferDb = new DatabaseSync(Buffer.from(bufferPath));
        bufferDb.exec('CREATE TABLE test (name TEXT)');
        bufferDb.prepare('INSERT INTO test (name) VALUES (?)').run('buffer');
        deepStrictEqual(bufferDb.prepare('SELECT name FROM test').get(), { name: 'buffer', __proto__: null });
        bufferDb.close();

        const urlDb = new DatabaseSync(new URL(`file://${urlPath}`));
        urlDb.exec('CREATE TABLE test (name TEXT)');
        urlDb.prepare('INSERT INTO test (name) VALUES (?)').run('url');
        deepStrictEqual(urlDb.prepare('SELECT name FROM test').get(), { name: 'url', __proto__: null });
        urlDb.close();
    } finally {
        Deno.removeSync(dir, { recursive: true });
    }
});

Deno.test('sqlite upstream: sqlite-type symbol and in-memory rows match Node shape', () => {
    const { DatabaseSync } = require('node:sqlite');
    const sqliteType = Symbol.for('sqlite-type');
    const db1 = new DatabaseSync(':memory:');
    const db2 = new DatabaseSync(':memory:');
    try {
        strictEqual(db1[sqliteType], 'node:sqlite');
        db1.exec('CREATE TABLE data(key INTEGER PRIMARY KEY)');
        db1.exec('INSERT INTO data (key) VALUES (1)');
        db2.exec('CREATE TABLE data(key INTEGER PRIMARY KEY)');
        db2.exec('INSERT INTO data (key) VALUES (2)');

        deepStrictEqual(db1.prepare('SELECT * FROM data').all(), [{ key: 1, __proto__: null }]);
        deepStrictEqual(db2.prepare('SELECT * FROM data').all(), [{ key: 2, __proto__: null }]);
    } finally {
        db1.close();
        db2.close();
    }
});

Deno.test('sqlite: DatabaseSync exec creates table', () => {
    const { DatabaseSync } = require('node:sqlite');
    const db = new DatabaseSync(':memory:');
    db.exec('CREATE TABLE t (id INTEGER PRIMARY KEY, name TEXT)');
    db.close();
});

Deno.test('sqlite upstream: exec accepts batch statements', () => {
    const { DatabaseSync } = require('node:sqlite');
    const db = new DatabaseSync(':memory:');
    try {
        db.exec(`
            CREATE TABLE one(id INTEGER PRIMARY KEY);
            CREATE TABLE two(id INTEGER PRIMARY KEY);
        `);
        deepStrictEqual(
            db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all(),
            [{ name: 'one', __proto__: null }, { name: 'two', __proto__: null }],
        );
    } finally {
        db.close();
    }
});

Deno.test('sqlite: DatabaseSync prepare returns statement', () => {
    const { DatabaseSync } = require('node:sqlite');
    const db = new DatabaseSync(':memory:');
    db.exec('CREATE TABLE s (id INTEGER PRIMARY KEY, val TEXT)');
    const stmt = db.prepare('INSERT INTO s (val) VALUES (?)');
    ok(typeof stmt === 'object');
    ok(typeof stmt.run === 'function');
    db.close();
});

Deno.test('sqlite: DatabaseSync statement run inserts row', () => {
    const { DatabaseSync } = require('node:sqlite');
    const db = new DatabaseSync(':memory:');
    db.exec('CREATE TABLE r (id INTEGER PRIMARY KEY, val TEXT)');
    const stmt = db.prepare('INSERT INTO r (val) VALUES (?)');
    const result = stmt.run('hello');
    strictEqual(result.changes, 1);
    ok(typeof result.lastInsertRowid === 'number' || typeof result.lastInsertRowid === 'bigint');
    db.close();
});

Deno.test('sqlite: DatabaseSync statement all retrieves rows', () => {
    const { DatabaseSync } = require('node:sqlite');
    const db = new DatabaseSync(':memory:');
    db.exec('CREATE TABLE a (id INTEGER PRIMARY KEY, val TEXT)');
    db.prepare('INSERT INTO a (val) VALUES (?)').run('x');
    db.prepare('INSERT INTO a (val) VALUES (?)').run('y');
    const rows = db.prepare('SELECT * FROM a ORDER BY id').all();
    ok(Array.isArray(rows));
    ok(rows.length === 2);
    db.close();
});

Deno.test('sqlite: DatabaseSync isOpen follows open and close lifecycle', () => {
    const { DatabaseSync } = require('node:sqlite');
    const db = new DatabaseSync(':memory:', { open: false });
    strictEqual(db.isOpen, false);
    db.open();
    strictEqual(db.isOpen, true);
    db.close();
    strictEqual(db.isOpen, false);
});

Deno.test('sqlite: DatabaseSync get returns first row object', () => {
    const { DatabaseSync } = require('node:sqlite');
    const db = new DatabaseSync(':memory:');
    try {
        db.exec('CREATE TABLE g (id INTEGER PRIMARY KEY, val TEXT)');
        db.prepare('INSERT INTO g (val) VALUES (?)').run('x');
        db.prepare('INSERT INTO g (val) VALUES (?)').run('y');
        const row = db.prepare('SELECT id, val FROM g ORDER BY id').get();
        strictEqual(row.id, 1);
        strictEqual(row.val, 'x');
    } finally {
        db.close();
    }
});

Deno.test('sqlite: DatabaseSync iterate yields rows in order', () => {
    const { DatabaseSync } = require('node:sqlite');
    const db = new DatabaseSync(':memory:');
    try {
        db.exec('CREATE TABLE i (id INTEGER PRIMARY KEY, val TEXT)');
        db.prepare('INSERT INTO i (val) VALUES (?)').run('x');
        db.prepare('INSERT INTO i (val) VALUES (?)').run('y');
        const iter = db.prepare('SELECT val FROM i ORDER BY id').iterate();
        const rows = Array.from(iter);
        deepStrictEqual(rows, [{ val: 'x', __proto__: null }, { val: 'y', __proto__: null }]);
        deepStrictEqual(iter.next(), { done: true, value: null });
    } finally {
        db.close();
    }
});

Deno.test('sqlite: StatementSync sourceSQL and columns reflect the statement', () => {
    const { DatabaseSync } = require('node:sqlite');
    const db = new DatabaseSync(':memory:');
    try {
        db.exec('CREATE TABLE c (id INTEGER PRIMARY KEY, val TEXT)');
        db.prepare('INSERT INTO c (val) VALUES (?)').run('x');
        const stmt = db.prepare('SELECT id, val FROM c');
        strictEqual(stmt.sourceSQL, 'SELECT id, val FROM c');
        deepStrictEqual(stmt.columns().map((column: { name: string }) => column.name), ['id', 'val']);
    } finally {
        db.close();
    }
});

Deno.test('sqlite: StatementSync setReturnArrays converts rows to arrays', () => {
    const { DatabaseSync } = require('node:sqlite');
    const db = new DatabaseSync(':memory:');
    try {
        db.exec('CREATE TABLE arr (id INTEGER PRIMARY KEY, val TEXT)');
        db.prepare('INSERT INTO arr (val) VALUES (?)').run('x');
        const stmt = db.prepare('SELECT id, val FROM arr');
        stmt.setReturnArrays(true);
        deepStrictEqual(stmt.get(), [1, 'x']);
    } finally {
        db.close();
    }
});

Deno.test('sqlite: StatementSync setReadBigInts returns bigint rowids', () => {
    const { DatabaseSync } = require('node:sqlite');
    const db = new DatabaseSync(':memory:');
    try {
        db.exec('CREATE TABLE big (id INTEGER PRIMARY KEY, val TEXT)');
        const stmt = db.prepare('INSERT INTO big (val) VALUES (?)');
        stmt.setReadBigInts(true);
        const result = stmt.run('x');
        strictEqual(typeof result.lastInsertRowid, 'bigint');
        strictEqual(result.lastInsertRowid, 1n);

        const select = db.prepare('SELECT id FROM big');
        deepStrictEqual(select.get(), { id: 1, __proto__: null });
        select.setReadBigInts(true);
        deepStrictEqual(select.get(), { id: 1n, __proto__: null });
        strictEqual(select.sourceSQL, 'SELECT id FROM big');
        strictEqual(select.expandedSQL, 'SELECT id FROM big');
    } finally {
        db.close();
    }
});

Deno.test('sqlite upstream: numbered positional parameters can be reused and reordered', () => {
    const { DatabaseSync } = require('node:sqlite');
    const db = new DatabaseSync(':memory:');
    try {
        db.exec(`
            CREATE TABLE users (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                name TEXT NOT NULL,
                email TEXT NOT NULL
            );
            CREATE TABLE nodes (
                id INTEGER PRIMARY KEY,
                parent_id INTEGER
            );
            CREATE TABLE order_test(a TEXT, b TEXT);
            INSERT INTO nodes (id, parent_id) VALUES (1, NULL), (2, 1), (3, 1), (4, 2);
        `);

        const inserted = db.prepare('INSERT INTO users (name, email) VALUES (?1, ?2)').run('Alice', 'alice@example.com');
        strictEqual(inserted.changes, 1);
        deepStrictEqual(
            db.prepare('SELECT name, email FROM users WHERE id = 1').get(),
            { name: 'Alice', email: 'alice@example.com', __proto__: null },
        );

        deepStrictEqual(
            db.prepare('SELECT * FROM nodes WHERE id = ?1 OR parent_id = ?1 ORDER BY id').all(1),
            [
                { id: 1, parent_id: null, __proto__: null },
                { id: 2, parent_id: 1, __proto__: null },
                { id: 3, parent_id: 1, __proto__: null },
            ],
        );

        db.prepare('INSERT INTO order_test (a, b) VALUES (?2, ?1)').run('first_arg', 'second_arg');
        deepStrictEqual(
            db.prepare('SELECT a, b FROM order_test').get(),
            { a: 'second_arg', b: 'first_arg', __proto__: null },
        );
    } finally {
        db.close();
    }
});

Deno.test('sqlite upstream: named parameters support bare names and unknown-name filtering', () => {
    const { DatabaseSync } = require('node:sqlite');
    const db = new DatabaseSync(':memory:');
    try {
        db.exec('CREATE TABLE named (id INTEGER PRIMARY KEY, variable1 TEXT NOT NULL, variable2 INT NOT NULL)');
        const stmt = db.prepare(
            'INSERT INTO named (variable1, variable2) VALUES (:variable1, :variable2)',
        );

        strictEqual(stmt.run({ variable1: 'first', variable2: 1 }).changes, 1);
        throws(() => stmt.run({ variable1: 'bad', variable2: 2, variable3: 'extra' }));

        stmt.setAllowUnknownNamedParameters(true);
        strictEqual(stmt.run({ variable1: 'second', variable2: 2, variable3: 'ignored' }).changes, 1);

        stmt.setAllowBareNamedParameters(false);
        throws(() => stmt.run({ variable1: 'third', variable2: 3 }));
        strictEqual(stmt.run({ ':variable1': 'third', ':variable2': 3 }).changes, 1);

        deepStrictEqual(
            db.prepare('SELECT variable1, variable2 FROM named ORDER BY id').all(),
            [
                { variable1: 'first', variable2: 1, __proto__: null },
                { variable1: 'second', variable2: 2, __proto__: null },
                { variable1: 'third', variable2: 3, __proto__: null },
            ],
        );
    } finally {
        db.close();
    }
});

Deno.test('sqlite upstream: empty blobs and large integer rows keep Node shapes', () => {
    const { DatabaseSync } = require('node:sqlite');
    const db = new DatabaseSync(':memory:');
    try {
        db.exec('CREATE TABLE blobs (data BLOB NOT NULL)');
        db.prepare('INSERT INTO blobs (data) VALUES (?)').run(new Uint8Array([]));
        deepStrictEqual(db.prepare('SELECT data FROM blobs').get(), { data: new Uint8Array([]), __proto__: null });

        deepStrictEqual(db.prepare('SELECT 2147483648').get(), { '2147483648': 2147483648, __proto__: null });
    } finally {
        db.close();
    }
});

Deno.test('sqlite upstream: reset after reads does not lock later schema changes', () => {
    const { DatabaseSync } = require('node:sqlite');
    const db = new DatabaseSync(':memory:');
    try {
        db.exec('CREATE TABLE foo(a integer, b text)');
        db.exec('CREATE TABLE bar(a integer, b text)');
        const stmt = db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name");
        deepStrictEqual(stmt.get(), { name: 'bar', __proto__: null });
        db.exec('DROP TABLE IF EXISTS foo');
        deepStrictEqual(db.prepare("SELECT name FROM sqlite_master WHERE name='foo'").all(), []);
    } finally {
        db.close();
    }
});

Deno.test('sqlite: DatabaseSync isTransaction toggles around BEGIN/COMMIT', () => {
    const { DatabaseSync } = require('node:sqlite');
    const db = new DatabaseSync(':memory:');
    try {
        strictEqual(db.isTransaction, false);
        db.exec('BEGIN');
        strictEqual(db.isTransaction, true);
        db.exec('COMMIT');
        strictEqual(db.isTransaction, false);
    } finally {
        db.close();
    }
});

Deno.test('sqlite: unsupported DatabaseSync.function throws runtime-specific error', () => {
    const { DatabaseSync } = require('node:sqlite');
    const db = new DatabaseSync(':memory:');
    let err: Error | null = null;
    try {
        db.function();
    } catch (error) {
        err = error as Error;
    } finally {
        db.close();
    }
    ok(err instanceof Error);
    strictEqual(err?.message, 'node:sqlite DatabaseSync.function is not implemented by this runtime');
});

Deno.test('sqlite: backup throws runtime-specific not-implemented error', () => {
    const { backup } = require('node:sqlite');
    let err: Error | null = null;
    try {
        backup();
    } catch (error) {
        err = error as Error;
    }
    ok(err instanceof Error);
    strictEqual(err?.message, 'node:sqlite backup is not implemented by this runtime');
});

Deno.test('sqlite: Session constructor throws runtime-specific not-implemented error', () => {
    const { Session } = require('node:sqlite');
    let err: Error | null = null;
    try {
        new Session();
    } catch (error) {
        err = error as Error;
    }
    ok(err instanceof Error);
    strictEqual(err?.message, 'node:sqlite Session is not implemented by this runtime');
});
