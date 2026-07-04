import { strictEqual, ok } from 'node:assert';
import { Database, Statement, verbose } from 'node:sqlite3';
import * as os from 'node:os';
import * as path from 'node:path';

const DB = path.join(os.tmpdir(), `cno-sqlite-${process.pid}.db`);

function stmtGet(stmt: any, ...args: any[]): Promise<any> {
    return new Promise((resolve, reject) => {
        stmt.get(...args, (err: Error | null, row: any) => err ? reject(err) : resolve(row));
    });
}

function stmtAll(stmt: any, ...args: any[]): Promise<any[]> {
    return new Promise((resolve, reject) => {
        stmt.all(...args, (err: Error | null, rows: any[]) => err ? reject(err) : resolve(rows));
    });
}

function dbGet(db: any, sql: string, ...args: any[]): Promise<any> {
    return new Promise((resolve, reject) => {
        db.get(sql, ...args, (err: Error | null, row: any) => err ? reject(err) : resolve(row));
    });
}

function dbAll(db: any, sql: string, ...args: any[]): Promise<any[]> {
    return new Promise((resolve, reject) => {
        db.all(sql, ...args, (err: Error | null, rows: any[]) => err ? reject(err) : resolve(rows));
    });
}

// --- 1. Database.open creates a file ----------------------------------------

Deno.test('sqlite3: Database.open creates a file', () => {
    const db = new Database(DB);
    ok(db);
    db.close();
});

// --- 2. exec runs multiple statements --------------------------------------

Deno.test('sqlite3: exec runs DDL', () => {
    const db = new Database(DB);
    db.exec('CREATE TABLE IF NOT EXISTS t (id INTEGER PRIMARY KEY, name TEXT)');
    db.exec('INSERT OR IGNORE INTO t (id, name) VALUES (1, "a")');
    db.close();
});

// --- 3. prepare returns a Statement ----------------------------------------

Deno.test('sqlite3: prepare returns Statement', () => {
    const db = new Database(DB);
    db.exec('CREATE TABLE IF NOT EXISTS t2 (id INTEGER)');
    const stmt = db.prepare('INSERT INTO t2 (id) VALUES (?)');
    ok(stmt instanceof Statement);
    stmt.run(1);
    db.close();
});

// --- 4. Statement.run returns changes/lastInsertRowid ---------------------

Deno.test('sqlite3: Statement.run returns result metadata', () => {
    const db = new Database(DB);
    db.exec('CREATE TABLE IF NOT EXISTS t3 (id INTEGER)');
    const stmt = db.prepare('INSERT INTO t3 (id) VALUES (?)');
    const r = stmt.run(42);
    ok(typeof r.changes === 'number');
    ok(r.changes >= 1);
    db.close();
});

// --- 5. Statement.get returns one row --------------------------------------

Deno.test('sqlite3: Statement.get callback returns first row', async () => {
    const db = new Database(DB);
    db.exec('CREATE TABLE IF NOT EXISTS t4 (id INTEGER, v TEXT)');
    db.exec('INSERT INTO t4 VALUES (1, "x")');
    const stmt = db.prepare('SELECT * FROM t4 WHERE id = ?');
    const row = await stmtGet(stmt, 1);
    ok(row);
    strictEqual(row.id, 1);
    strictEqual(row.v, 'x');
    db.close();
});

// --- 6. Statement.all returns all rows -------------------------------------

Deno.test('sqlite3: Statement.all callback returns all rows', async () => {
    const db = new Database(DB);
    db.exec('CREATE TABLE IF NOT EXISTS t5 (id INTEGER)');
    db.exec('INSERT INTO t5 VALUES (1), (2), (3)');
    const stmt = db.prepare('SELECT * FROM t5 ORDER BY id');
    const rows = await stmtAll(stmt);
    ok(Array.isArray(rows));
    ok(rows.length >= 3);
    db.close();
});

// --- 7. Statement.each visits rows -----------------------------------------

Deno.test('sqlite3: Statement.each visits rows', async () => {
    const db = new Database(DB);
    db.exec('CREATE TABLE IF NOT EXISTS t6 (id INTEGER)');
    db.exec('INSERT INTO t6 VALUES (1), (2)');
    const stmt = db.prepare('SELECT * FROM t6 ORDER BY id');
    const ids = await new Promise<number[]>((resolve, reject) => {
        const rows: number[] = [];
        stmt.each(
            (err: Error | null, row: any) => err ? reject(err) : rows.push(row.id),
            (err: Error | null) => err ? reject(err) : resolve(rows)
        );
    });
    ok(ids.length >= 2);
    db.close();
});

// --- 8. Database.serialize invokes callback -------------------------------

Deno.test('sqlite3: Database.serialize invokes callback', () => {
    const db = new Database(DB);
    let called = false;
    db.serialize(() => { called = true; });
    ok(called);
    db.close();
});

// --- 9. Database.get callback returns row ---------------------------------

Deno.test('sqlite3: Database.get callback returns row', async () => {
    const db = new Database(DB);
    db.exec('CREATE TABLE IF NOT EXISTS t9 (id INTEGER, v TEXT)');
    db.exec('INSERT INTO t9 VALUES (1, "db-get")');
    const row = await dbGet(db, 'SELECT * FROM t9 WHERE id = ?', 1);
    strictEqual(row.v, 'db-get');
    db.close();
});

// --- 10. Database.all callback returns rows --------------------------------

Deno.test('sqlite3: Database.all callback returns rows', async () => {
    const db = new Database(DB);
    db.exec('CREATE TABLE IF NOT EXISTS t10 (id INTEGER)');
    db.exec('INSERT INTO t10 VALUES (1), (2), (3)');
    const rows = await dbAll(db, 'SELECT * FROM t10 ORDER BY id');
    ok(Array.isArray(rows));
    ok(rows.length >= 3);
    db.close();
});

// --- 11. Database.configure accepts trace/profile/busyTimeout --------------

Deno.test('sqlite3: Database.configure accepts trace/profile/busyTimeout', () => {
    const db = new Database(DB);
    db.configure('trace', () => {});
    db.configure('profile', () => {});
    db.configure('busyTimeout', 100);
    db.close();
});

// --- 12. Statement.run with named params ----------------------------------

Deno.test('sqlite3: Statement.run with named params', async () => {
    const db = new Database(DB);
    db.exec('CREATE TABLE IF NOT EXISTS t12 (id INTEGER, v TEXT)');
    const stmt = db.prepare('INSERT INTO t12 (id, v) VALUES (:id, :v)');
    stmt.run({ id: 7, v: 'seven' });
    const row = await stmtGet(db.prepare('SELECT * FROM t12 WHERE id = 7'));
    strictEqual(row.v, 'seven');
    db.close();
});

// --- 13. verbose() returns sqlite3 instance --------------------------------

Deno.test('sqlite3: verbose() returns sqlite3', () => {
    const s = verbose();
    ok(typeof s === 'object');
});
