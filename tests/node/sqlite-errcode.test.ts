import { deepStrictEqual, ok, strictEqual } from 'node:assert';
import { DatabaseSync } from 'node:sqlite';

// ============================================================================
// node:sqlite — error `errcode` / `message` fidelity
//
// Node's `errcode` is SQLite's *extended* result code and its `message` is
// sqlite3_errmsg (the detailed one). Measured against Node v24.18.0:
//
//   constraint      errcode  errstr               message
//   UNIQUE(v)         2067   "constraint failed"  "UNIQUE constraint failed: u.v"
//   PRIMARY KEY(k)    1555   "constraint failed"  "UNIQUE constraint failed: u.k"
//   NOT NULL(nn)      1299   "constraint failed"  "NOT NULL constraint failed: u.nn"
//   CHECK(ck)          275   "constraint failed"  "CHECK constraint failed: ck > 5"
//   FOREIGN KEY        787   "constraint failed"  "FOREIGN KEY constraint failed"
//   syntax error         1   "SQL logic error"    "near \"FROM\": syntax error"
//   no such table        1   "SQL logic error"    "no such table: nope"
//
// The extended code is the only thing that distinguishes a UNIQUE violation
// from a NOT NULL / CHECK / FOREIGN KEY one, because `errstr` is identical
// ("constraint failed") for all five: sqlite3_errstr() masks its argument with
// `rc &= 0xff` internally, so it always yields the primary code's string.
//
// cno matches all of the above as of the 2026-08-03 build. It previously
// reported the *primary* code (19 = SQLITE_CONSTRAINT) for all five constraint
// kinds, with `message` set from sqlite3_errstr rather than sqlite3_errmsg, so
// the five collapsed into one indistinguishable error. Fixed in
// circu.js/src/mod_sqlite3.c: `tjs_throw_sqlite3_err_db()` reads
// sqlite3_extended_errcode + sqlite3_errmsg off the connection (reached via
// sqlite3_db_handle(stmt), so no struct change), wired into exec, prepare, and
// the post-sqlite3_step paths in stmt_all and stmt_run. It was not reachable
// from TypeScript: the binding exposes no accessor for either value, and errstr
// is byte-identical across all five, so nothing was left to derive from.
//
// Two facts that make the fix correct, from the SQLite amalgamation rather than
// assumption: sqlite3_extended_result_codes() is NOT a prerequisite (it only
// sets db->errMask, which sqlite3_errcode() applies and extended_errcode() does
// not), and sqlite3_errstr() masks internally, so `errstr` keeps matching Node
// for free. The helper also guards on masked agreement between the connection's
// error and the thrown one, so a stale errmsg cannot attach to an unrelated
// throw.
//
// These tests assert the fixed values directly. Reverting the C helper collapses
// the five errcodes back to one and turns `message` into `errstr` — both of
// which fail loudly here.
// ============================================================================

const SQLITE_CONSTRAINT = 19;
const SQLITE_ERROR = 1;

/** Node's extended codes, which cno now reports too. */
const NODE_EXTENDED = {
    unique: 2067,
    primaryKey: 1555,
    notNull: 1299,
    check: 275,
    foreignKey: 787,
} as const;

type SqliteErr = Error & { code?: string; errcode?: number; errstr?: string };

function freshDb(): InstanceType<typeof DatabaseSync> {
    const db = new DatabaseSync(':memory:');
    db.exec(
        'CREATE TABLE u (k INTEGER PRIMARY KEY, v TEXT UNIQUE, nn TEXT NOT NULL, ck INTEGER CHECK (ck > 5));'
        + 'CREATE TABLE child (id INTEGER, parent INTEGER REFERENCES u(k));',
    );
    db.exec("INSERT INTO u (k, v, nn, ck) VALUES (1, 'a', 'x', 10)");
    return db;
}

function capture(fn: () => void): SqliteErr {
    try {
        fn();
    } catch (e) {
        return e as SqliteErr;
    }
    throw new Error('expected a throw, got none');
}

// --- 1. The shape that already matches Node -------------------------------

Deno.test('sqlite errcode: every constraint error has Node\'s exact enumerable shape', () => {
    const db = freshDb();
    db.exec('PRAGMA foreign_keys = ON');

    const cases: Array<[string, () => void]> = [
        ['UNIQUE', () => db.exec("INSERT INTO u (k, v, nn, ck) VALUES (2, 'a', 'y', 10)")],
        ['PRIMARY KEY', () => db.exec("INSERT INTO u (k, v, nn, ck) VALUES (1, 'b', 'y', 10)")],
        ['NOT NULL', () => db.exec("INSERT INTO u (k, v, nn, ck) VALUES (3, 'c', NULL, 10)")],
        ['CHECK', () => db.exec("INSERT INTO u (k, v, nn, ck) VALUES (4, 'd', 'y', 1)")],
        ['FOREIGN KEY', () => db.exec('INSERT INTO child (id, parent) VALUES (1, 999)')],
    ];

    for (const [name, fn] of cases) {
        const e = capture(fn);
        strictEqual(e.code, 'ERR_SQLITE_ERROR', `${name}: code`);
        strictEqual(e.errstr, 'constraint failed', `${name}: errstr`);
        strictEqual(typeof e.errcode, 'number', `${name}: errcode is a number`);
        // Node's enumerable key set, exactly — no more, no less.
        deepStrictEqual(Object.keys(e).sort(), ['code', 'errcode', 'errstr'], `${name}: keys`);
    }
    db.close();
});

Deno.test('sqlite errcode: non-constraint errors report SQLITE_ERROR and the logic-error string', () => {
    const db = freshDb();
    for (const sql of ['SELECT FROM WHERE', 'SELECT * FROM nope', 'SELECT nope FROM u']) {
        const e = capture(() => db.exec(sql));
        strictEqual(e.code, 'ERR_SQLITE_ERROR', sql);
        strictEqual(e.errstr, 'SQL logic error', sql);
        strictEqual(e.errcode, SQLITE_ERROR, sql);
    }
    db.close();
});

// --- 2. The recorded divergence -------------------------------------------

Deno.test('sqlite errcode: every constraint kind reports Node\'s exact extended code', () => {
    const db = freshDb();
    db.exec('PRAGMA foreign_keys = ON');

    const cases: Array<[keyof typeof NODE_EXTENDED, () => void]> = [
        ['unique', () => db.exec("INSERT INTO u (k, v, nn, ck) VALUES (2, 'a', 'y', 10)")],
        ['primaryKey', () => db.exec("INSERT INTO u (k, v, nn, ck) VALUES (1, 'b', 'y', 10)")],
        ['notNull', () => db.exec("INSERT INTO u (k, v, nn, ck) VALUES (3, 'c', NULL, 10)")],
        ['check', () => db.exec("INSERT INTO u (k, v, nn, ck) VALUES (4, 'd', 'y', 1)")],
        ['foreignKey', () => db.exec('INSERT INTO child (id, parent) VALUES (1, 999)')],
    ];

    const seen = new Set<number>();
    for (const [kind, fn] of cases) {
        const e = capture(fn);
        const expected = NODE_EXTENDED[kind];
        // Every extended constraint code masks down to the primary one; that is
        // precisely why reporting only the primary code lost the distinction.
        strictEqual(expected & 0xff, SQLITE_CONSTRAINT, `${kind}: extended code must mask to SQLITE_CONSTRAINT`);
        strictEqual(e.errcode, expected, `${kind}: errcode must be Node's extended ${expected}, got ${e.errcode}`);
        seen.add(e.errcode!);
    }

    // The point of the fix: five constraint kinds are five distinguishable
    // values, so a caller can branch on errcode the way it can on real Node.
    // Reverting mod_sqlite3.c's tjs_throw_sqlite3_err_db collapses this to 1.
    strictEqual(
        seen.size,
        5,
        `all five constraint kinds must be distinguishable; saw ${[...seen].sort((a, b) => a - b).join(',')}`,
    );
    db.close();
});

Deno.test('sqlite errcode: message is the detailed errmsg, naming the column', () => {
    const db = freshDb();
    const e = capture(() => db.exec("INSERT INTO u (k, v, nn, ck) VALUES (2, 'a', 'y', 10)"));

    // Node's message comes from sqlite3_errmsg and names the exact column, so it
    // is strictly more informative than errstr. errstr stays the primary-code
    // string because sqlite3_errstr() masks internally — both runtimes agree
    // there, and that parity is free.
    strictEqual(e.message, 'UNIQUE constraint failed: u.v', 'message must be sqlite3_errmsg');
    strictEqual(e.errstr, 'constraint failed', 'errstr stays the primary-code string, as in Node');
    ok(e.message !== e.errstr, 'message must now be more specific than errstr');
    db.close();
});
