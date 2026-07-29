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

Deno.test('sqlite: DatabaseSync.function registers UDF and SELECT uses it', () => {
    const { DatabaseSync } = require('node:sqlite');
    const db = new DatabaseSync(':memory:');
    try {
        db.exec('CREATE TABLE nums(x INTEGER); INSERT INTO nums VALUES (3), (5)');
        db.function('js_double', (x: number) => x * 2);
        const rows = db.prepare('SELECT js_double(x) AS d FROM nums ORDER BY x').all();
        deepStrictEqual(rows, [{ d: 6, __proto__: null }, { d: 10, __proto__: null }]);

        db.function('js_add', (a: number, b: number) => a + b);
        strictEqual(db.prepare('SELECT js_add(?, ?) AS s').get(10, 7)?.s, 17);

        db.function('greet', { deterministic: true }, (n: string) => `hi ${n}`);
        strictEqual(db.prepare('SELECT greet(?) AS g').get('bob')?.g, 'hi bob');

        db.function('sumall', { varargs: true }, (...args: number[]) => args.reduce((s, x) => s + x, 0));
        strictEqual(db.prepare('SELECT sumall(1, 2, 3, 4) AS v').get()?.v, 10);
    } finally {
        db.close();
    }
});

Deno.test('sqlite: DatabaseSync.function rejects missing function argument', () => {
    const { DatabaseSync } = require('node:sqlite');
    const db = new DatabaseSync(':memory:');
    try {
        throws(() => (db.function as any)('x'), TypeError);
        throws(() => (db.function as any)('', () => 1), TypeError);
        throws(() => (db.function as any)('null_options', null, () => 1), TypeError);
        throws(() => (db.function as any)('undefined_options', undefined, () => 1), TypeError);
    } finally {
        db.close();
    }
});

Deno.test('sqlite: function options match Node boolean validation', () => {
    const { DatabaseSync } = require('node:sqlite');
    const db = new DatabaseSync(':memory:');
    try {
        for (const name of ['deterministic', 'directOnly', 'varargs', 'useBigIntArguments']) {
            for (const value of [null, 0, 1, 'true', {}]) {
                throws(() => (db.function as any)(`invalid_${name}`, { [name]: value }, () => 1), TypeError);
            }
            (db.function as any)(`undefined_${name}`, { [name]: undefined }, () => 1);
        }

        const options: any[] = [];
        Reflect.set(options, 'varargs', true);
        db.function('array_options', options as any, (...values: number[]) => values.length);
        strictEqual(db.prepare('SELECT array_options(1, 2, 3) AS value').get()?.value, 3);
    } finally {
        db.close();
    }
});

Deno.test('sqlite: UDF arguments preserve embedded NUL and reject unsafe integers', () => {
    const { DatabaseSync } = require('node:sqlite');
    const db = new DatabaseSync(':memory:');
    try {
        let textCodes: number[] = [];
        db.function('inspect_text', (value: string) => {
            textCodes = [...value].map(character => character.charCodeAt(0));
            return value.length;
        });
        strictEqual(db.prepare("SELECT inspect_text(char(97, 0, 98)) AS value").get()?.value, 3);
        deepStrictEqual(textCodes, [97, 0, 98]);

        let calls = 0;
        db.function('inspect_integer', (value: number) => {
            calls++;
            return String(value);
        });
        strictEqual(
            db.prepare('SELECT inspect_integer(9007199254740991) AS value').get()?.value,
            '9007199254740991',
        );
        throws(() => db.prepare('SELECT inspect_integer(9007199254740992)').get());
        strictEqual(calls, 1);

        db.function('inspect_bigint', { useBigIntArguments: true }, (value: bigint) => `${typeof value}:${value}`);
        strictEqual(
            db.prepare('SELECT inspect_bigint(9007199254740992) AS value').get()?.value,
            'bigint:9007199254740992',
        );
    } finally {
        db.close();
    }
});

Deno.test('sqlite: UDF replacement and failed registration keep callback state valid', () => {
    const { DatabaseSync } = require('node:sqlite');
    const db = new DatabaseSync(':memory:');
    try {
        for (let i = 0; i < 64; i++) db.function('replace_me', () => i);
        strictEqual(db.prepare('SELECT replace_me() AS value').get()?.value, 63);

        throws(() => db.function('x'.repeat(256), () => 1));
        throws(() => db.aggregate('x'.repeat(256), { start: 0, step: (acc: number) => acc }));
        strictEqual(db.prepare('SELECT replace_me() AS value').get()?.value, 63);
    } finally {
        db.close();
    }
});

Deno.test('sqlite: directOnly functions reject indirect schema use', () => {
    const { DatabaseSync } = require('node:sqlite');
    const db = new DatabaseSync(':memory:');
    try {
        db.function('secret_value', { directOnly: true }, () => 7);
        db.exec('CREATE VIEW secret_view AS SELECT secret_value() AS value');
        strictEqual(db.prepare('SELECT secret_value() AS value').get()?.value, 7);
        throws(() => db.prepare('SELECT value FROM secret_view').get());
    } finally {
        db.close();
    }
});

Deno.test('sqlite: backup copies rows to destination path', async () => {
    const { DatabaseSync, backup } = require('node:sqlite');
    const dir = Deno.makeTempDirSync({ prefix: 'cno-sqlite-backup-' });
    const srcPath = `${dir}/src.db`;
    const destPath = `${dir}/dest.db`;
    const db = new DatabaseSync(srcPath);
    try {
        db.exec("CREATE TABLE t(x TEXT, n INT); INSERT INTO t VALUES ('hi', 1), ('yo', 2)");
        const pages = await backup(db, destPath);
        ok(typeof pages === 'number');
        ok(pages > 0);

        const dest = new DatabaseSync(destPath);
        try {
            deepStrictEqual(
                dest.prepare('SELECT * FROM t ORDER BY n').all(),
                [{ x: 'hi', n: 1, __proto__: null }, { x: 'yo', n: 2, __proto__: null }],
            );
        } finally {
            dest.close();
        }

        // options source/target names (default main)
        const dest2 = `${dir}/dest2.db`;
        const pages2 = await backup(db, dest2, { source: 'main', target: 'main' });
        ok(pages2 > 0);
        const d2 = new DatabaseSync(dest2);
        try {
            strictEqual(d2.prepare('SELECT COUNT(*) AS c FROM t').get()?.c, 2);
        } finally {
            d2.close();
        }
    } finally {
        db.close();
        Deno.removeSync(dir, { recursive: true });
    }
});

Deno.test('sqlite: backup rejects missing path', async () => {
    const { DatabaseSync, backup } = require('node:sqlite');
    const db = new DatabaseSync(':memory:');
    try {
        let err: unknown = null;
        try {
            await (backup as any)(db);
        } catch (e) {
            err = e;
        }
        ok(err instanceof TypeError);
    } finally {
        db.close();
    }
});

Deno.test('sqlite: DatabaseSync.aggregate registers UDF and SELECT uses it', () => {
    const { DatabaseSync } = require('node:sqlite');
    const db = new DatabaseSync(':memory:');
    try {
        db.exec('CREATE TABLE nums(x INTEGER); INSERT INTO nums VALUES (1), (2), (3)');
        db.aggregate('mysum', {
            start: 0,
            step: (acc: number, x: number) => acc + x,
            result: (acc: number) => acc,
        });
        strictEqual(db.prepare('SELECT mysum(x) AS s FROM nums').get()?.s, 6);

        // empty group still returns start via result
        db.exec('DELETE FROM nums');
        strictEqual(db.prepare('SELECT mysum(x) AS s FROM nums').get()?.s, 0);

        db.exec("CREATE TABLE words(s TEXT); INSERT INTO words VALUES ('a'), ('b')");
        db.aggregate('myjoin', {
            start: () => [] as string[],
            step: (acc: string[], x: string) => {
                acc.push(x);
                return acc;
            },
            result: (acc: string[]) => acc.join(','),
        });
        strictEqual(db.prepare('SELECT myjoin(s) AS j FROM words').get()?.j, 'a,b');
    } finally {
        db.close();
    }
});

Deno.test('sqlite: DatabaseSync.aggregate rejects missing step', () => {
    const { DatabaseSync } = require('node:sqlite');
    const db = new DatabaseSync(':memory:');
    try {
        throws(() => (db.aggregate as any)('x', { start: 0 }), TypeError);
        throws(() => (db.aggregate as any)('', { start: 0, step: () => 0 }), TypeError);
        throws(() => (db.aggregate as any)('null_inverse', { start: 0, step: () => 0, inverse: null }), TypeError);
    } finally {
        db.close();
    }
});

Deno.test('sqlite: aggregate options match Node validation and result coercion', () => {
    const { DatabaseSync } = require('node:sqlite');
    const db = new DatabaseSync(':memory:');
    try {
        for (const name of ['directOnly', 'varargs', 'useBigIntArguments']) {
            for (const value of [null, 0, 1, 'true', {}]) {
                throws(() => (db.aggregate as any)(`invalid_${name}`, {
                    start: 0,
                    step: (acc: number) => acc,
                    [name]: value,
                }), TypeError);
            }
        }

        for (const [index, result] of [null, 0, 'ignored', {}].entries()) {
            db.aggregate(`ignored_result_${index}`, {
                start: 0,
                step: (acc: number, value: number) => acc + value,
                result,
            });
            strictEqual(db.prepare(`SELECT ignored_result_${index}(x) AS value FROM (
                SELECT 1 AS x UNION ALL SELECT 2
            )`).get()?.value, 3);
        }

        const options: any[] = [];
        Reflect.set(options, 'start', 0);
        Reflect.set(options, 'step', (acc: number, value: number) => acc + value);
        db.aggregate('array_aggregate_options', options as any);
        strictEqual(db.prepare('SELECT array_aggregate_options(4) AS value').get()?.value, 4);
    } finally {
        db.close();
    }
});

Deno.test('sqlite: aggregate inverse supports sliding windows', () => {
    const { DatabaseSync } = require('node:sqlite');
    const db = new DatabaseSync(':memory:');
    try {
        db.exec('CREATE TABLE nums(x INTEGER); INSERT INTO nums VALUES (1), (2), (3)');
        db.aggregate('rolling_sum', {
            start: 0,
            step: (acc: number, value: number) => acc + value,
            inverse: (acc: number, value: number) => acc - value,
            result: (acc: number) => acc,
        });
        deepStrictEqual(
            db.prepare(`
                SELECT x, rolling_sum(x) OVER (
                    ORDER BY x ROWS BETWEEN 1 PRECEDING AND CURRENT ROW
                ) AS sum
                FROM nums
            `).all(),
            [
                { x: 1, sum: 1, __proto__: null },
                { x: 2, sum: 3, __proto__: null },
                { x: 3, sum: 5, __proto__: null },
            ],
        );
    } finally {
        db.close();
    }
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

Deno.test('sqlite: createSession remains fail-closed', () => {
    const { DatabaseSync } = require('node:sqlite');
    const db = new DatabaseSync(':memory:');
    try {
        throws(() => db.createSession(), /createSession is not implemented/);
    } finally {
        db.close();
    }
});
