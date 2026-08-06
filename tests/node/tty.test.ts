import { strictEqual, ok, throws } from 'node:assert';
import * as tty from 'node:tty';
import * as fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const thisFile = fileURLToPath(import.meta.url);

// --- 1. isatty returns false for a regular file ---------------------------

Deno.test('tty: isatty false for regular file', () => {
    // A normal file fd is not a TTY.
    const fd = fs.openSync(thisFile, 'r');
    try {
        strictEqual(tty.isatty(fd), false);
    } finally {
        fs.closeSync(fd);
    }
});

// --- 2. isatty returns boolean --------------------------------------------

Deno.test('tty: isatty returns boolean', () => {
    const fd = fs.openSync(thisFile, 'r');
    try {
        ok(typeof tty.isatty(fd) === 'boolean');
    } finally {
        fs.closeSync(fd);
    }
});

// --- 3. isatty on stdin/stdout/stderr returns boolean ---------------------

Deno.test('tty: isatty on stdio fds returns boolean', () => {
    for (const fd of [0, 1, 2]) {
        ok(typeof tty.isatty(fd) === 'boolean');
    }
});

Deno.test('tty: isatty on stdio fds matches process stdio isTTY flags', () => {
    strictEqual(tty.isatty(0), !!process.stdin?.isTTY);
    strictEqual(tty.isatty(1), !!process.stdout?.isTTY);
    strictEqual(tty.isatty(2), !!process.stderr?.isTTY);
});

// --- 4. ReadStream and WriteStream are exported ---------------------------

Deno.test('tty: ReadStream and WriteStream exist', () => {
    ok(typeof tty.ReadStream === 'function');
    ok(typeof tty.WriteStream === 'function');
});

// --- 5. ReadStream.prototype has setRawMode -----------------------------

Deno.test('tty: ReadStream has setRawMode', () => {
    ok('setRawMode' in tty.ReadStream.prototype);
    strictEqual((tty.ReadStream.prototype as typeof tty.ReadStream.prototype & { isTTY?: unknown }).isTTY, undefined);
});

// --- 6. WriteStream.prototype has cursorTo / clearLine / getWindowSize ---

Deno.test('tty: WriteStream has cursor/clear/window methods', () => {
    for (const m of ['cursorTo', 'clearLine', 'clearScreenDown', 'getWindowSize', 'columns', 'rows']) {
        ok(m in tty.WriteStream.prototype, `WriteStream must have ${m}`);
    }
    strictEqual((tty.WriteStream.prototype as typeof tty.WriteStream.prototype & { isTTY?: unknown }).isTTY, true);
});

// --- 7. isatty throws on invalid fd ---------------------------------------

Deno.test('tty: isatty on negative fd returns false', () => {
    strictEqual(tty.isatty(-1), false);
});

Deno.test('tty: isatty returns false for invalid fd values', () => {
    for (const value of [0.5, 1.3, 'abc', {}, [], null, undefined]) {
        strictEqual(tty.isatty(value as number), false);
    }
});

Deno.test('tty: WriteStream prototype color helpers match upstream shape', () => {
    strictEqual(tty.WriteStream.prototype.hasColors(), true);
    strictEqual(tty.WriteStream.prototype.hasColors({}), true);
    // Node rejects a count below 2 (ERR_OUT_OF_RANGE), verified against v24.18.
    throws(() => tty.WriteStream.prototype.hasColors(1), RangeError);
    ok([1, 4, 8, 24].includes(tty.WriteStream.prototype.getColorDepth()));
});

// --- tty: color gating matches Node's internal/tty.js -----------------------

function colorProbe() {
    const P = tty.WriteStream.prototype as unknown as {
        getColorDepth(env?: Record<string, string>): number;
        hasColors(count?: number | Record<string, string>, env?: Record<string, string>): boolean;
    };
    return { isTTY: true, getColorDepth: P.getColorDepth, hasColors: P.hasColors };
}

Deno.test('tty: NO_COLOR and NODE_DISABLE_COLORS force depth 1', () => {
    strictEqual(colorProbe().getColorDepth({ NO_COLOR: '1' }), 1);
    strictEqual(colorProbe().getColorDepth({ NODE_DISABLE_COLORS: '1' }), 1);
    strictEqual(colorProbe().getColorDepth({ TERM: 'dumb' }), 1);
    // An empty NO_COLOR is ignored by Node (verified against v24.18).
    ok(colorProbe().getColorDepth({ NO_COLOR: '' }) > 1);
});

Deno.test('tty: FORCE_COLOR levels match Node', () => {
    strictEqual(colorProbe().getColorDepth({ FORCE_COLOR: '0' }), 1);
    strictEqual(colorProbe().getColorDepth({ FORCE_COLOR: '1' }), 4);
    strictEqual(colorProbe().getColorDepth({ FORCE_COLOR: 'true' }), 4);
    strictEqual(colorProbe().getColorDepth({ FORCE_COLOR: '' }), 4);
    strictEqual(colorProbe().getColorDepth({ FORCE_COLOR: '2' }), 8);
    strictEqual(colorProbe().getColorDepth({ FORCE_COLOR: '3' }), 24);
    // An unrecognised value means "no color", not "fall through".
    strictEqual(colorProbe().getColorDepth({ FORCE_COLOR: 'abc' }), 1);
});

Deno.test('tty: hasColors() defaults count to 16 and respects NO_COLOR', () => {
    // Returning true unconditionally here is what made packages emit colour
    // even under NO_COLOR.
    strictEqual(colorProbe().hasColors({ NO_COLOR: '1' }), false);
    strictEqual(colorProbe().hasColors({ FORCE_COLOR: '0' }), false);
    strictEqual(colorProbe().hasColors({ FORCE_COLOR: '1' }), true);
    strictEqual(colorProbe().hasColors(256, { FORCE_COLOR: '1' }), false);
    strictEqual(colorProbe().hasColors(256, { FORCE_COLOR: '2' }), true);
});

Deno.test('tty: hasColors validates count like Node', () => {
    throws(() => colorProbe().hasColors(1, {}), RangeError);
    throws(() => colorProbe().hasColors('x' as unknown as number, {}), TypeError);
});
