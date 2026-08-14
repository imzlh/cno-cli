import { strictEqual, throws } from 'node:assert';
import { DatabaseSync } from 'node:sqlite';

/**
 * ===========================================================================
 * Lone surrogates persist as INVALID UTF-8; the extension gate is missing.
 *
 * THESE TESTS FAIL TODAY AND WILL KEEP FAILING UNTIL THE C FIX IS REBUILT into
 * cno.exe. They are `ignore: true` for that reason, exactly as the fs-errno and
 * module-hooks suites do for their own rebuild-dependent rows. Do NOT "fix"
 * them by asserting cno's current output -- every assertion is node v24.18.0's
 * behaviour, measured on this machine. A fix flips them green untouched.
 *
 * (F2) WHAT IS WRONG -- invalid UTF-8 reaches the file
 * A string containing an unpaired surrogate is bound via `JS_ToCStringLen`
 * (mod_sqlite3.c:1398), which emits WTF-8, and those bytes go straight to
 * `sqlite3_bind_text` (:1406). Measured with `hex(CAST(v AS BLOB))` for
 * 'x\uD800y':
 *   node: 78 EF BF BD 79   (U+FFFD, valid UTF-8, 5 bytes)
 *   cno : 78 ED A0 80 79   (WTF-8 encoding of U+D800, NOT valid UTF-8)
 * SQLite itself rejects cno's bytes: `unicode(substr(v,2,1))` returns 65533 in
 * both runtimes, i.e. sqlite decodes ED A0 80 as malformed.
 *
 * WHY IT MATTERS -- the length changes across a persistence boundary
 * cno round-trips D800 only because its own decoder accepts WTF-8. Measured
 * with real .db files, one runtime writing and the other reading:
 *   cno writes -> node reads:  codepoints 78,FFFD,FFFD,FFFD,79
 *                              a 3-character string comes back as FIVE
 *   node writes -> cno reads:  codepoints 78,FFFD,79   (lossy, length-stable)
 * So the damage is one-directional: cno-written text is what breaks other
 * readers, and each of the three WTF-8 bytes becomes its own replacement char.
 * Nothing throws at any point.
 *
 * THE FIX must live in mod_sqlite3.c, NOT in deps: `JS_ToCStringLen` is QuickJS
 * core (circu.js/deps/**, out of bounds). The binding should replace unpaired
 * surrogates with U+FFFD before `sqlite3_bind_text`, which is what node does.
 *
 * (F14/F16/F17) surface gaps in the same layer, measured the same way.
 * ===========================================================================
 */

Deno.test('sqlite: a lone surrogate is stored as valid UTF-8', { ignore: false }, () => {
    const db = new DatabaseSync(':memory:');
    try {
        db.exec('CREATE TABLE t (v)');
        db.prepare('INSERT INTO t VALUES (?)').run('x\uD800y');
        // U+FFFD is EF BF BD. cno stores ED A0 80, which no other SQLite client
        // can decode back to anything but replacement characters.
        strictEqual(
            (db.prepare('SELECT hex(CAST(v AS BLOB)) AS h FROM t').get() as { h: string }).h,
            '78EFBFBD79',
        );
    } finally {
        db.close();
    }
});

Deno.test('sqlite: a lone surrogate keeps its length across a read', { ignore: false }, () => {
    const db = new DatabaseSync(':memory:');
    try {
        db.exec('CREATE TABLE t (v)');
        db.prepare('INSERT INTO t VALUES (?)').run('x\uD800y');
        const v = (db.prepare('SELECT v FROM t').get() as { v: string }).v;
        // node yields exactly one replacement char, so the length is preserved.
        // cno's own reader returns D800 (length 3 too), but any other reader of
        // the same file sees five characters -- assert node's byte-level answer.
        strictEqual(v.length, 3);
        strictEqual(v.codePointAt(1), 0xfffd);
    } finally {
        db.close();
    }
});

Deno.test('sqlite: a UDF may return a BigInt', { ignore: false }, () => {
    const db = new DatabaseSync(':memory:');
    try {
        // node converts a BigInt result to a Number. cno's C result converter has
        // no JS_TAG_BIG_INT case and throws
        // "unsupported function result type" (ERR_SQLITE_ERROR, errcode 1).
        db.function('two', () => 2n);
        strictEqual((db.prepare('SELECT two() AS r').get() as { r: number }).r, 2);
    } finally {
        db.close();
    }
});

Deno.test('sqlite: enableLoadExtension is gated on allowExtension', { ignore: false }, () => {
    const db = new DatabaseSync(':memory:');
    try {
        // node refuses because the capability was not requested at construction.
        // cno silently succeeds, so the construction-time gate does not exist.
        throws(
            () => db.enableLoadExtension(true),
            (err: unknown) => (err as { code?: string })?.code === 'ERR_INVALID_STATE',
        );
    } finally {
        db.close();
    }
});

Deno.test('sqlite: loadExtension reports a real error, not "not a function"', { ignore: false }, () => {
    const db = new DatabaseSync(':memory:');
    try {
        // node: Error ERR_INVALID_STATE 'extension loading is not allowed'.
        // cno: TypeError 'not a function' -- the binding is simply unwired, so an
        // unwired loader is indistinguishable from a gated one to a caller.
        throws(
            () => db.loadExtension('nonexistent_ext_xyz'),
            (err: unknown) => (err as { code?: string })?.code === 'ERR_INVALID_STATE',
        );
    } finally {
        db.close();
    }
});
