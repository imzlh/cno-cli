import { strictEqual, ok } from 'node:assert';

// Stack-trace COLUMN anchoring, split by expression kind.
//
// Measured against node v24 and tsc --sourceMap: cno reports 0-based columns
// where V8 reports 1-based. Adding the missing +1 in js_get_source_mapping()
// (circu.js/src/sourcemap.c) fixes plain call frames exactly, but `new X(...)`
// frames have a SECOND, independent discrepancy: cno anchors the constructor
// identifier while V8 anchors the `new` keyword, so those frames land 3
// columns right even after the +1 lands.
//
// sourcemap-stack-position.test.ts asserts only a plain call frame, so a
// half-fix turns it green while `new` frames stay wrong. This file is the
// guard for the second half. Both cases must pass together.
//
// Lines are NOT affected — they are correct today, including after a large
// erased type block. Only columns are.

// Fixture lines are pinned; keep the two functions on ONE line each so the
// expected columns below stay stable and readable.
/* eslint-disable */
function callFrame(): never { return thrower(); }               // line 22
function newFrame(): never { throw new Error('anchor'); }        // line 23
function thrower(): never { throw new Error('inner'); }         // line 24
/* eslint-enable */

// 1-based columns, computed from the source text above.
// line 22: `function callFrame(): never { return thrower(); }`
//                                               ^ `thrower` at column 38
const CALL_COL = 38;
// line 23: `function newFrame(): never { throw new Error('anchor'); }`
//                                              ^ `new` at column 36
const NEW_KEYWORD_COL = 36;

interface Frame { line: number; col: number }

function topFrameIn(stack: string, needle: string): Frame | null {
    for (const raw of stack.split('\n')) {
        if (!raw.includes('sourcemap-column-anchor')) continue;
        if (!raw.includes(needle)) continue;
        const m = raw.match(/:(\d+):(\d+)\)?\s*$/);
        if (m) return { line: Number(m[1]), col: Number(m[2]) };
    }
    return null;
}

function stackOf(fn: () => unknown): string {
    try { fn(); } catch (e) { return String((e as Error).stack); }
    throw new Error('fixture did not throw');
}

Deno.test('sourcemap: plain call frame column is 1-based', () => {
    const f = topFrameIn(stackOf(callFrame), 'callFrame');
    ok(f, 'no callFrame frame found');
    strictEqual(f!.line, 22, 'line must be the original .ts line');
    strictEqual(
        f!.col,
        CALL_COL,
        'plain call frame column must be 1-based; a value one less means the '
        + '+1 for columns is missing in js_get_source_mapping() '
        + '(circu.js/src/sourcemap.c)',
    );
});

Deno.test('sourcemap: `new X()` frame anchors the `new` keyword, not the constructor name', () => {
    const f = topFrameIn(stackOf(newFrame), 'newFrame');
    ok(f, 'no newFrame frame found');
    strictEqual(f!.line, 23, 'line must be the original .ts line');
    // V8 anchors `new`. Anchoring `Error` instead lands at NEW_KEYWORD_COL + 4
    // 1-based, i.e. +3 once the 0-based column is also corrected.
    strictEqual(
        f!.col,
        NEW_KEYWORD_COL,
        '`new X()` frame must anchor the `new` keyword like V8; '
        + `${NEW_KEYWORD_COL + 4} means it anchors the constructor identifier, `
        + `and ${NEW_KEYWORD_COL + 3} means it anchors the constructor `
        + 'identifier AND is still 0-based. Adding the +1 in '
        + 'js_get_source_mapping() alone does NOT fix this frame kind.',
    );
});
