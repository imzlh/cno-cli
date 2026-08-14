import { deepStrictEqual, strictEqual } from 'node:assert';
import { DatabaseSync } from 'node:sqlite';

// ============================================================================
// node:sqlite — StatementSync.columns() must not EXECUTE the statement
//
// columns() is metadata-only in Node: it reads the column list off the prepared
// statement without stepping it. cno derived the metadata by calling get(),
// which steps the statement, so a metadata call ran the statement's side
// effects. Measured against Node v24.18.0 with one script run under both:
//
//   prepare('INSERT INTO t VALUES(99)').columns()
//       node: rows after = 0     cno (before): rows after = 1
//   prepare('DELETE FROM t').columns()   on a 3-row table
//       node: rows after = 3     cno (before): rows after = 0   <- all rows gone
//
// A DELETE losing every row to a call that is documented to inspect metadata is
// silent data destruction: it throws nothing and returns the [] Node also
// returns for a non-row statement, so no caller can notice.
//
// The native statement binding exposes sqlite3_column_count/name directly, so
// this remains metadata-only for every SQL spelling and also works when a SELECT
// currently has no rows. Rich origin/type metadata remains a separate gap.
// ============================================================================

Deno.test('sqlite: columns() on an INSERT does not insert a row', () => {
    const db = new DatabaseSync(':memory:');
    try {
        db.exec('CREATE TABLE t (v)');
        const stmt = db.prepare('INSERT INTO t VALUES (99)');
        deepStrictEqual(stmt.columns(), []);
        strictEqual(
            (db.prepare('SELECT COUNT(*) AS c FROM t').get() as { c: number }).c,
            0,
            'columns() executed the INSERT',
        );
    } finally {
        db.close();
    }
});

Deno.test('sqlite: columns() on a DELETE does not delete rows', () => {
    const db = new DatabaseSync(':memory:');
    try {
        db.exec('CREATE TABLE t (v)');
        db.exec('INSERT INTO t VALUES (1), (2), (3)');
        const stmt = db.prepare('DELETE FROM t');
        deepStrictEqual(stmt.columns(), []);
        strictEqual(
            (db.prepare('SELECT COUNT(*) AS c FROM t').get() as { c: number }).c,
            3,
            'columns() executed the DELETE',
        );
    } finally {
        db.close();
    }
});

Deno.test('sqlite: columns() on an UPDATE does not modify rows', () => {
    const db = new DatabaseSync(':memory:');
    try {
        db.exec('CREATE TABLE t (v)');
        db.exec('INSERT INTO t VALUES (1), (2)');
        const stmt = db.prepare('UPDATE t SET v = v + 100');
        deepStrictEqual(stmt.columns(), []);
        strictEqual(
            (db.prepare('SELECT group_concat(v) AS g FROM t').get() as { g: string }).g,
            '1,2',
            'columns() executed the UPDATE',
        );
    } finally {
        db.close();
    }
});

// A CTE is only safe to step when it wraps no DML. `WITH ... DELETE` is a real
// SQLite form and must not be mistaken for a read just because it starts WITH.
Deno.test('sqlite: columns() on WITH wrapping a DELETE does not delete', () => {
    const db = new DatabaseSync(':memory:');
    try {
        db.exec('CREATE TABLE t (v)');
        db.exec('INSERT INTO t VALUES (1), (2), (3)');
        const stmt = db.prepare('WITH doomed AS (SELECT v FROM t) DELETE FROM t WHERE v IN (SELECT v FROM doomed)');
        stmt.columns();
        strictEqual(
            (db.prepare('SELECT COUNT(*) AS c FROM t').get() as { c: number }).c,
            3,
            'columns() executed the WITH ... DELETE',
        );
    } finally {
        db.close();
    }
});

// The gate must not cost the SELECT path its metadata.
Deno.test('sqlite: columns() still reports names for a SELECT', () => {
    const db = new DatabaseSync(':memory:');
    try {
        db.exec('CREATE TABLE t (a INTEGER, b TEXT)');
        db.exec("INSERT INTO t VALUES (1, 'x')");
        deepStrictEqual(
            db.prepare('SELECT a, b AS bee FROM t').columns().map((c: { name: string }) => c.name),
            ['a', 'bee'],
        );
        // a leading comment must not hide the SELECT from the gate
        deepStrictEqual(
            db.prepare('-- leading comment\nSELECT a FROM t').columns().map((c: { name: string }) => c.name),
            ['a'],
        );
        deepStrictEqual(
            db.prepare('/* block */ SELECT b FROM t').columns().map((c: { name: string }) => c.name),
            ['b'],
        );
        // WITH wrapping a plain SELECT is a read and must keep working
        deepStrictEqual(
            db.prepare('WITH cte AS (SELECT a FROM t) SELECT a FROM cte').columns().map((c: { name: string }) => c.name),
            ['a'],
        );
    } finally {
        db.close();
    }
});

Deno.test({
    name: 'sqlite: columns() reports empty-query metadata without invoking a UDF',
    // WAS expected-red pre-rebuild. Native `columnNames()`
    // (circu.js/src/mod_sqlite3.c:1698) is now LINKED into build/stage/cno.exe
    // (Aug 10 12:58): `grep -a -o columnNames | wc -l` = 1, and functionally
    // `typeof stmt.columnNames === 'function'`. columns() therefore takes the
    // native path and never steps, so a UDF in the projection is not invoked and
    // metadata no longer depends on a row being present — columns() on an EMPTY
    // table returns the names now where it used to return [].
    // Un-ignored because it passes: a green test left skipped protects nothing.
    fn: () => {
    const db = new DatabaseSync(':memory:');
    try {
        let calls = 0;
        db.function('side_effect', () => ++calls);
        const stmt = db.prepare('SELECT side_effect() AS answer WHERE 0');
        deepStrictEqual(stmt.columns().map((c: { name: string }) => c.name), ['answer']);
        strictEqual(calls, 0, 'columns() must not step the statement or call its UDF');
    } finally {
        db.close();
    }
    },
});

// columns() must not consume the cursor either: Node leaves the statement
// fully re-runnable, and this held in cno before the fix too. Keep it pinned.
Deno.test('sqlite: columns() leaves a SELECT fully re-runnable', () => {
    const db = new DatabaseSync(':memory:');
    try {
        db.exec('CREATE TABLE t (v)');
        db.exec('INSERT INTO t VALUES (1), (2), (3)');
        const stmt = db.prepare('SELECT v FROM t');
        stmt.columns();
        strictEqual(stmt.all().length, 3);
    } finally {
        db.close();
    }
});

// ============================================================================
// EXPECTED-RED, REBUILD-GATED: columns() reports only `name`, not Node's five
// keys. Measured on this machine, same script both runtimes:
//
//   SELECT a FROM t   (a INTEGER in table t)
//     node: { column: 'a', database: 'main', name: 'a', table: 't', type: 'INTEGER' }
//     cno : { name: 'a' }
//   SELECT a + 1 AS calc FROM t
//     node: { column: null, database: null, name: 'calc', table: null, type: null }
//     cno : { name: 'calc' }
//   Object.keys(cols[0])
//     node: ['column','database','name','table','type']    cno: ['name']
//
// The four missing fields are sqlite3_column_origin_name / _table_name /
// _database_name / _decltype. None is reachable from JS today, and they are NOT
// derivable from a column name -- deriving them would mean parsing the SQL, i.e.
// guessing, which is the same mistake that made the int64 path return two
// different wrong answers. So this cannot be closed in the TS layer.
//
// A native `columnMetadata()` returning Node's exact shape is now written
// (circu.js/src/mod_sqlite3.c, registered next to `columnNames`) and
// mod.ts:columns() prefers it when present, but it is NOT in build/stage/cno.exe
// yet -- that binary is Aug 11 09:56 and predates it, so `typeof
// stmt.columnMetadata` is 'undefined' and columns() falls back to the
// name-only `columnNames()` path. This flips green on the next rebuild with no
// edit to any assertion.
//
// The linked SQLite does support the metadata APIs: sqlite 3.53.3 from vcpkg,
// verified by compiling and RUNNING a standalone C probe against
// E:/vcpkg/installed/x64-windows/debug/lib/sqlite3.lib, which printed
// origin=a table=t db=main for a table column and all-null for an expression --
// matching node exactly. CMake gates the three flag-dependent accessors on a
// link check (SQLITE_HAS_COLUMN_METADATA -> TJS_SQLITE_HAS_COLUMN_METADATA).
// ============================================================================
Deno.test({
    name: 'sqlite: columns() reports Node\'s full five-key metadata',
    ignore: true, // needs native columnMetadata() linked into cno.exe
    fn: () => {
        // Node's columns() entries are `[Object: null prototype] {...}` and
        // deepStrictEqual compares prototypes, so the expected values must be
        // null-prototype too. Asserting plain object literals here fails against
        // real node's own output -- measured, not assumed.
        const bare = (o: object) => Object.assign(Object.create(null), o);
        const db = new DatabaseSync(':memory:');
        try {
            db.exec('CREATE TABLE t (a INTEGER, b VARCHAR(9), c)');
            // A real table column carries its origin and declared type.
            deepStrictEqual(db.prepare('SELECT a FROM t').columns(), [
                bare({ column: 'a', database: 'main', name: 'a', table: 't', type: 'INTEGER' }),
            ]);
            // An alias renames `name` but leaves `column` as the origin.
            deepStrictEqual(db.prepare('SELECT b AS lbl FROM t').columns(), [
                bare({ column: 'b', database: 'main', name: 'lbl', table: 't', type: 'VARCHAR(9)' }),
            ]);
            // A column with no declared type: origin present, type null.
            deepStrictEqual(db.prepare('SELECT c FROM t').columns(), [
                bare({ column: 'c', database: 'main', name: 'c', table: 't', type: null }),
            ]);
            // An expression has no origin at all -- every field but name is null,
            // and the keys are still present.
            deepStrictEqual(db.prepare('SELECT a + 1 AS calc FROM t').columns(), [
                bare({ column: null, database: null, name: 'calc', table: null, type: null }),
            ]);
            // Node's exact key set and order.
            deepStrictEqual(
                Object.keys(db.prepare('SELECT a FROM t').columns()[0] as object),
                ['column', 'database', 'name', 'table', 'type'],
            );
            strictEqual(Object.getPrototypeOf(db.prepare('SELECT a FROM t').columns()[0]), null);
            // The no-side-effects guarantee must survive the richer path.
            db.exec('INSERT INTO t VALUES (1, \'x\', 2)');
            const del = db.prepare('DELETE FROM t');
            deepStrictEqual(del.columns(), []);
            strictEqual((db.prepare('SELECT COUNT(*) AS c FROM t').get() as { c: number }).c, 1);
        } finally {
            db.close();
        }
    },
});

