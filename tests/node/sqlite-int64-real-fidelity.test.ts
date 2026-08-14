import { strictEqual, throws } from 'node:assert';
import { DatabaseSync } from 'node:sqlite';

/**
 * ===========================================================================
 * CRITICAL: an integer-valued value can be WRITTEN and then NOT READ BACK.
 *
 * THESE TESTS FAIL TODAY AND WILL KEEP FAILING UNTIL THE C FIX IS REBUILT into
 * cno.exe. They are `ignore: true` for that reason, exactly as the fs-errno and
 * module-hooks suites do for their own rebuild-dependent rows. Do NOT "fix"
 * them by asserting cno's current output -- every assertion below is node
 * v24.18.0's behaviour, measured on this machine, which is correct by
 * definition. A fix flips them green without editing a single assertion.
 *
 * WHAT IS WRONG
 * `tjs__stmt2obj()` read int64 columns through `JS_NewInt64`, which narrows
 * anything outside int32 to a double and so destroys the low bits past 2**53
 * (9007199254740993 arrived as ...992). A narrowed value is indistinguishable
 * from a genuine REAL once it reaches JS, so the TS layer had to GUESS from the
 * value's shape. The guess produces two separate wrong answers:
 *
 * (a) REAL, integer-valued, |v| in [2**53, 2**63] -- WRITE SUCCEEDS, READ THROWS.
 *     Measured, same script both runtimes, fresh DB per case:
 *       value    node (read)              cno (read)
 *       2**53    9007199254740992         THROWS ERR_OUT_OF_RANGE
 *       1e16     10000000000000000        THROWS ERR_OUT_OF_RANGE
 *       1e18     1000000000000000000      THROWS ERR_OUT_OF_RANGE
 *       9e18     9000000000000000000      THROWS ERR_OUT_OF_RANGE
 *       -1e18    -1000000000000000000     THROWS ERR_OUT_OF_RANGE
 *     `setReadBigInts(true)` does not help. Only |v| > 2**63 (1e19, 1e20,
 *     1e300) and non-integral values work, because those miss the int64 range
 *     and so never take the integer path.
 *
 * (b) INTEGER past 2**53 with `setReadBigInts(true)` -- THROWS instead of
 *     returning the exact BigInt, which is the entire purpose of the switch.
 *     Measured per magnitude, INTEGER column:
 *       magnitude   node off   node on                cno off   cno on
 *       <=2**53-1   Number     BigInt                 same      same
 *       2**53       THROW      9007199254740992n      THROW     THROWS
 *       2**53+1     THROW      9007199254740993n      THROW     THROWS
 *       1e18        THROW      1000000000000000000n   THROW     THROWS
 *       2**63-1     THROW      9223372036854775807n   THROW     THROWS
 *       -2**63      THROW      -9223372036854775808n  THROW     BigInt (passes
 *                                                     only because -2**63 is
 *                                                     exact as a double)
 *     The readBigInts-OFF column matches node everywhere and must stay.
 *
 * WHY IT MATTERS
 * (a) is data that goes in and cannot come out: a nanosecond epoch timestamp
 * (~1.7e18), a large surrogate key or a byte count lands in the file and every
 * later read of that row throws. Nothing warns at write time.
 *
 * NOTE ON tests/node/sqlite.test.ts
 *  - `:887` PINS DEFECT (b): it asserts `throws(..., outOfRange)` for
 *    readBigInts ON where node returns 9007199254740993n. When the fix lands
 *    that line must become a `strictEqual` on the exact BigInt. Its
 *    readBigInts-OFF sibling at `:884` is correct parity and must stay.
 *  - `:904` states "A large REAL is not an int64 and must not be widened or
 *    rejected" but both its arms test only 1e300 -- the single magnitude that
 *    happens to work -- so defect (a) slips through. The 1e18 rows below are
 *    the extension of that arm, held here until the rebuild.
 *
 * THE FIX (C half applied to source, compile-verified, awaiting rebuild)
 * `circu.js/src/mod_sqlite3.c` `tjs__stmt2obj()`: hand the int64 up exactly --
 * `JS_NewInt32` in int32 range, `JS_NewFloat64` in the safe-but-wide range,
 * `JS_NewBigInt64` beyond it -- and let `convertCell()` apply node's policy. C
 * must not throw, because it cannot see `readBigInts`. The already-correct
 * sibling `tjs__sqlite3_value_to_js()` at `:452` uses `JS_NewBigInt64` the same
 * way; it can throw only because its caller hands it an explicit `use_bigint`.
 * The TS half (dropping the shape-guessing in `convertCell`) must land in the
 * SAME commit as the rebuild: before it, C still narrows, and removing the
 * throw would return silently-wrong numbers instead of erroring.
 * ===========================================================================
 */

// -------------------------------------------------------------------- (a) REAL
Deno.test('sqlite: an integer-valued REAL past 2**53 reads back', { ignore: false }, () => {
    const db = new DatabaseSync(':memory:');
    try {
        // SQL literals with a decimal point are unambiguously REAL: no binding,
        // no storage-class ambiguity. typeof(v) is 'real' in both runtimes.
        strictEqual((db.prepare('SELECT 9007199254740992.0 AS v').get() as { v: number }).v, 9007199254740992);
        strictEqual((db.prepare('SELECT 10000000000000000.0 AS v').get() as { v: number }).v, 1e16);
        strictEqual((db.prepare('SELECT 1000000000000000000.0 AS v').get() as { v: number }).v, 1e18);
        strictEqual((db.prepare('SELECT 9000000000000000000.0 AS v').get() as { v: number }).v, 9e18);
        strictEqual((db.prepare('SELECT -1000000000000000000.0 AS v').get() as { v: number }).v, -1e18);
    } finally {
        db.close();
    }
});

Deno.test('sqlite: a REAL written as a Number reads back unchanged', { ignore: false }, () => {
    const db = new DatabaseSync(':memory:');
    try {
        db.exec('CREATE TABLE t (v)');
        db.prepare('INSERT INTO t VALUES (?)').run(1e18);
        strictEqual((db.prepare('SELECT typeof(v) AS ty FROM t').get() as { ty: string }).ty, 'real');
        // the write above succeeded; this is the read that throws
        strictEqual((db.prepare('SELECT v FROM t').get() as { v: number }).v, 1e18);
    } finally {
        db.close();
    }
});

// This is the extension of sqlite.test.ts:904 asked for: that arm tests only
// 1e300, which is above int64 range and therefore never takes the integer path.
Deno.test('sqlite: a large REAL is not widened or rejected under readBigInts', { ignore: false }, () => {
    const db = new DatabaseSync(':memory:');
    try {
        const mid = db.prepare('SELECT 1e18 AS v');
        mid.setReadBigInts(true);
        // node keys readBigInts off the column's storage class, so a REAL stays a
        // Number even with the switch on. cno decides from the value's shape and
        // returns a BigInt for any integer-valued REAL (defect F4).
        strictEqual((mid.get() as { v: number }).v, 1e18);
        const small = db.prepare('SELECT 2.0 AS v');
        small.setReadBigInts(true);
        strictEqual((small.get() as { v: number }).v, 2);
    } finally {
        db.close();
    }
});

// ----------------------------------------------------------------- (b) INTEGER
Deno.test('sqlite: readBigInts returns the exact int64 past 2**53', { ignore: false }, () => {
    const db = new DatabaseSync(':memory:');
    try {
        db.exec('CREATE TABLE big (v INTEGER)');
        db.exec('INSERT INTO big VALUES (9007199254740993)');
        const wide = db.prepare('SELECT v FROM big');
        wide.setReadBigInts(true);
        // This is the assertion sqlite.test.ts:887 currently inverts.
        strictEqual((wide.get() as { v: bigint }).v, 9007199254740993n);

        // readBigInts OFF must still throw -- that half already matches node and
        // is asserted here so a fix cannot regress it by loosening both paths.
        const narrow = db.prepare('SELECT v FROM big');
        throws(
            () => narrow.get(),
            (err: unknown) => (err as { code?: string })?.code === 'ERR_OUT_OF_RANGE',
        );
    } finally {
        db.close();
    }
});

Deno.test('sqlite: readBigInts is exact at the int64 boundaries', { ignore: false }, () => {
    const db = new DatabaseSync(':memory:');
    try {
        db.exec('CREATE TABLE t (v INTEGER)');
        const ins = db.prepare('INSERT INTO t VALUES (?)');
        for (const v of [9007199254740992n, 1000000000000000000n, 4611686018427387904n, 9223372036854775807n]) {
            db.exec('DELETE FROM t');
            ins.run(v);
            const s = db.prepare('SELECT v FROM t');
            s.setReadBigInts(true);
            strictEqual((s.get() as { v: bigint }).v, v);
        }
    } finally {
        db.close();
    }
});
