import { strictEqual, ok, throws } from 'node:assert';
import { Backup, Database, Statement, verbose, OPEN_READONLY } from 'node:sqlite3';
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
    strictEqual(db.serialize(() => { called = true; }), db);
    ok(called);
    db.close();
});

Deno.test('sqlite3: Database.parallelize invokes callback and returns db', () => {
    const db = new Database(DB);
    let called = false;
    strictEqual(db.parallelize(() => { called = true; }), db);
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

Deno.test('sqlite3: Database.wait invokes callback and returns db', async () => {
    const db = new Database(DB);
    try {
        await new Promise<void>((resolve, reject) => {
            strictEqual(db.wait((err?: Error | null) => err ? reject(err) : resolve()), db);
        });
    } finally {
        db.close();
    }
});

Deno.test('sqlite3: trace and profile hooks observe executed SQL', async () => {
    const db = new Database(DB);
    const traces: string[] = [];
    const profiles: Array<{ sql: string; ms: number }> = [];
    db.configure('trace', (sql: string) => traces.push(sql));
    db.configure('profile', (sql: string, ms: number) => profiles.push({ sql, ms }));
    try {
        db.exec('CREATE TABLE IF NOT EXISTS t11_trace (id INTEGER)');
        await new Promise<void>((resolve, reject) => {
            db.run('INSERT INTO t11_trace (id) VALUES (?)', 1, (err?: Error | null) => err ? reject(err) : resolve());
        });
        ok(traces.some((sql) => sql.includes('INSERT INTO t11_trace')));
        ok(profiles.some((entry) => entry.sql.includes('INSERT INTO t11_trace') && entry.ms >= 0));
    } finally {
        db.close();
    }
});

Deno.test('sqlite3: unsupported configure option throws', () => {
    const db = new Database(DB);
    let err: Error | null = null;
    try {
        db.configure('unsupported-option', 1);
    } catch (error) {
        err = error as Error;
    } finally {
        db.close();
    }
    ok(err instanceof Error);
    strictEqual(err?.message, 'Unsupported sqlite3 configure option: unsupported-option');
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

Deno.test('sqlite3: Statement.finalize invokes callback and future use errors', async () => {
    const db = new Database(DB);
    db.exec('CREATE TABLE IF NOT EXISTS t13 (id INTEGER)');
    const stmt = db.prepare('INSERT INTO t13 (id) VALUES (?)');
    await new Promise<void>((resolve, reject) => {
        strictEqual(stmt.finalize((err?: Error | null) => err ? reject(err) : resolve()), stmt);
    });

    let err: Error | null = null;
    try {
        stmt.run(1);
    } catch (error) {
        err = error as Error;
    }
    ok(err instanceof Error);
    strictEqual(err?.message, 'Statement has been finalized');
    db.close();
});

// --- 13. verbose() returns sqlite3 instance --------------------------------

Deno.test('sqlite3: verbose() returns sqlite3', () => {
    const s = verbose();
    ok(typeof s === 'object');
});

Deno.test('sqlite3: verbose() returns the sqlite3 module object', () => {
    const sqlite3 = require('node:sqlite3');
    strictEqual(verbose(), sqlite3);
});

Deno.test('sqlite3: Database.backup initializes before step copies rows', async () => {
    const dir = Deno.makeTempDirSync({ prefix: 'cno-sqlite3-backup-' });
    const srcPath = `${dir}/src.db`;
    const destPath = `${dir}/dest.db`;
    const db = new Database(srcPath);
    try {
        db.exec("CREATE TABLE t(x TEXT, n INT); INSERT INTO t VALUES ('hi', 1), ('yo', 2)");
        let backup!: Backup;
        backup = await new Promise<Backup>((resolve, reject) => {
            const created = db.backup(destPath, function(this: Backup, err?: Error | null) {
                if (err) {
                    reject(err);
                    return;
                }
                strictEqual(this, created);
                strictEqual(this.completed, false);
                strictEqual(this.pageCount, 0);
                resolve(this);
            });
            strictEqual(created.completed, false);
        });

        let completedEvents = 0;
        backup.on('completed', () => completedEvents++);
        await new Promise<void>((resolve, reject) => {
            strictEqual(backup.step(-1, function(this: Backup, err?: Error | null) {
                strictEqual(this, backup);
                if (err) reject(err);
                else resolve();
            }), backup);
        });
        strictEqual(backup.completed, true);
        strictEqual(backup.failed, false);
        strictEqual(backup.idle, true);
        strictEqual(backup.remaining, 0);
        ok(backup.pageCount > 0);
        strictEqual(completedEvents, 1);

        await new Promise<void>((resolve, reject) => {
            backup.step(-1, (err?: Error | null) => err ? reject(err) : resolve());
        });
        strictEqual(completedEvents, 1);

        for (let i = 0; i < 2; i++) {
            await new Promise<void>((resolve, reject) => {
                strictEqual(backup.finish(function(this: Backup, err?: Error | null) {
                    strictEqual(this, backup);
                    if (err) reject(err);
                    else resolve();
                }), backup);
            });
        }

        const dest = new Database(destPath, OPEN_READONLY);
        try {
            const rows = await new Promise<Record<string, unknown>[]>((resolve, reject) => {
                dest.all('SELECT * FROM t ORDER BY n', (err: unknown, result?: Record<string, unknown>[]) => {
                    if (err) reject(err);
                    else resolve(result ?? []);
                });
            });
            strictEqual(rows.length, 2);
            strictEqual(rows[0]?.x, 'hi');
            strictEqual(rows[0]?.n, 1);
            strictEqual(rows[1]?.x, 'yo');
            strictEqual(rows[1]?.n, 2);
        } finally {
            dest.close();
        }
    } finally {
        db.close();
        Deno.removeSync(dir, { recursive: true });
    }
});

Deno.test('sqlite3: Backup positive step completes once and rejects step after finish', async () => {
    const dir = Deno.makeTempDirSync({ prefix: 'cno-sqlite3-bak2-' });
    const srcPath = `${dir}/s.db`;
    const destPath = `${dir}/d.db`;
    const db = new Database(srcPath);
    try {
        db.exec("CREATE TABLE w(v TEXT); INSERT INTO w VALUES ('ok')");
        const bak = new Backup(db, destPath);
        const invalidPagesError = await new Promise<Error | null>((resolve) => {
            bak.step(0, (err?: Error | null) => resolve(err ?? null));
        });
        ok(invalidPagesError instanceof RangeError);
        strictEqual(bak.failed, false);
        await new Promise<void>((resolve, reject) => {
            bak.step(1, (err?: Error | null) => err ? reject(err) : resolve());
        });
        ok(bak.completed);
        strictEqual(bak.remaining, 0);
        ok(bak.pageCount > 0);
        await new Promise<void>((resolve, reject) => {
            bak.finish((err?: Error | null) => err ? reject(err) : resolve());
        });
        const afterFinishError = await new Promise<Error | null>((resolve) => {
            bak.step(-1, (err?: Error | null) => resolve(err ?? null));
        });
        ok(afterFinishError instanceof Error);
        strictEqual(afterFinishError?.message, 'Backup has already been finished');

        const dest = new Database(destPath);
        try {
            const row = await new Promise<Record<string, unknown>>((resolve, reject) => {
                dest.get('SELECT v FROM w', (err: unknown, r?: Record<string, unknown>) => {
                    if (err) reject(err);
                    else resolve(r ?? {});
                });
            });
            strictEqual(row.v, 'ok');
        } finally {
            dest.close();
        }
    } finally {
        db.close();
        Deno.removeSync(dir, { recursive: true });
    }
});

Deno.test('sqlite3: Backup.finish does not implicitly copy', async () => {
    const dir = Deno.makeTempDirSync({ prefix: 'cno-sqlite3-bak-finish-' });
    const srcPath = `${dir}/s.db`;
    const destPath = `${dir}/d.db`;
    const db = new Database(srcPath);
    try {
        db.exec('CREATE TABLE untouched(v TEXT)');
        const backup = new Backup(db, destPath);
        await new Promise<void>((resolve, reject) => {
            backup.finish((err?: Error | null) => err ? reject(err) : resolve());
        });
        strictEqual(backup.completed, false);
        strictEqual(backup.pageCount, 0);
        throws(() => Deno.statSync(destPath), Deno.errors.NotFound);
    } finally {
        db.close();
        Deno.removeSync(dir, { recursive: true });
    }
});

Deno.test('sqlite3: Database.backup reports invalid path by throw or callback', async () => {
    const db = new Database(':memory:');
    try {
        throws(() => db.backup(''), TypeError);
        let failed!: Backup;
        const error = await new Promise<Error | null>((resolve) => {
            failed = db.backup('', function(this: Backup, err?: Error | null) {
                strictEqual(this, failed);
                resolve(err ?? null);
            });
        });
        ok(error instanceof TypeError);
        strictEqual(failed.failed, true);
    } finally {
        db.close();
    }
});
