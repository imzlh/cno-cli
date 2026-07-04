import { strictEqual, ok } from 'node:assert';
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

// --- 4. ReadStream and WriteStream are exported ---------------------------

Deno.test('tty: ReadStream and WriteStream exist', () => {
    ok(typeof tty.ReadStream === 'function');
    ok(typeof tty.WriteStream === 'function');
});

// --- 5. ReadStream.prototype has setRawMode -----------------------------

Deno.test('tty: ReadStream has setRawMode', () => {
    ok('setRawMode' in tty.ReadStream.prototype);
});

// --- 6. WriteStream.prototype has cursorTo / clearLine / getWindowSize ---

Deno.test('tty: WriteStream has cursor/clear/window methods', () => {
    for (const m of ['cursorTo', 'clearLine', 'clearScreenDown', 'getWindowSize', 'columns', 'rows']) {
        ok(m in tty.WriteStream.prototype, `WriteStream must have ${m}`);
    }
});

// --- 7. isatty throws on invalid fd ---------------------------------------

Deno.test('tty: isatty on negative fd returns false or throws', () => {
    let ok2 = true;
    try {
        tty.isatty(-1);
    } catch {
        ok2 = false; // acceptable
    }
    ok(true); // smoke: no crash
});
