import { strictEqual, ok } from 'node:assert';

// ============================================================================
// sqlite (not sqlite3) — newer node:sqlite experimental API
// ============================================================================

Deno.test('sqlite: module loads', () => {
    const sqlite = require('node:sqlite');
    ok(typeof sqlite === 'object');
});

Deno.test('sqlite: DatabaseSync is constructor', () => {
    const { DatabaseSync } = require('node:sqlite');
    ok(typeof DatabaseSync === 'function');
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

Deno.test('sqlite: DatabaseSync exec creates table', () => {
    const { DatabaseSync } = require('node:sqlite');
    const db = new DatabaseSync(':memory:');
    db.exec('CREATE TABLE t (id INTEGER PRIMARY KEY, name TEXT)');
    db.close();
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
    stmt.run('hello');
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
