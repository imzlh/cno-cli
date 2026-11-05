// @cno-host: false
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const bundled = await build({
    absWorkingDir: fileURLToPath(new URL('../..', import.meta.url)),
    entryPoints: ['cno/src/bun/utils/color.ts'],
    bundle: true,
    format: 'esm',
    platform: 'node',
    target: 'es2024',
    write: false,
});
const { color, ansiColorDepth, setStdoutColorDepthProvider } =
    await import(`data:text/javascript;base64,${Buffer.from(bundled.outputFiles[0].text).toString('base64')}`);

test('color depth: FORCE_COLOR overrides everything, even without a TTY', () => {
    assert.equal(ansiColorDepth({ FORCE_COLOR: '0' }, true), 0);
    assert.equal(ansiColorDepth({ FORCE_COLOR: '0' }, false), 0);
    assert.equal(ansiColorDepth({ FORCE_COLOR: '1' }, false), 1);
    assert.equal(ansiColorDepth({ FORCE_COLOR: 'true' }, false), 1);
    assert.equal(ansiColorDepth({ FORCE_COLOR: '' }, false), 1);
    assert.equal(ansiColorDepth({ FORCE_COLOR: '2' }, false), 2);
    assert.equal(ansiColorDepth({ FORCE_COLOR: '3' }, false), 3);
    // Numeric strings parse (leading zeros included) and clamp to 0-3.
    assert.equal(ansiColorDepth({ FORCE_COLOR: '00' }, false), 0);
    assert.equal(ansiColorDepth({ FORCE_COLOR: '02' }, false), 2);
    // Values outside 0-2 clamp to truecolor.
    assert.equal(ansiColorDepth({ FORCE_COLOR: '9' }, false), 3);
    // Case-insensitive false disables; true/garbage fall back to ANSI 16
    // (verified against the installed Bun 1.4.4 oracle).
    assert.equal(ansiColorDepth({ FORCE_COLOR: 'false' }, false), 0);
    assert.equal(ansiColorDepth({ FORCE_COLOR: 'FALSE' }, false), 0);
    assert.equal(ansiColorDepth({ FORCE_COLOR: 'TRUE' }, false), 1);
    assert.equal(ansiColorDepth({ FORCE_COLOR: 'garbage' }, false), 1);
    assert.equal(ansiColorDepth({ FORCE_COLOR: '1', NO_COLOR: '1' }, true), 1);
});

test('color depth: NO_COLOR disables output before any terminal detection', () => {
    assert.equal(ansiColorDepth({ NO_COLOR: '1' }, true), 0);
    assert.equal(ansiColorDepth({ NO_COLOR: '' }, true), 0);
    // Bun's oracle: NO_COLOR=false and NO_COLOR=0 are not disable requests.
    assert.equal(ansiColorDepth({ NO_COLOR: '0', TERM: 'xterm-256color' }, true), 2);
    assert.equal(ansiColorDepth({ NO_COLOR: 'false', TERM: 'xterm-256color' }, true), 2);
    assert.equal(ansiColorDepth({ NO_COLOR: 'FALSE' }, true), 0);
});

test('color depth: TERM-based detection answers regardless of stdout TTY', () => {
    // Bun 1.4.4 oracle: piped stdout with TERM=xterm-256color still gets ANSI
    // from the automatic format; only enableANSIColors (a different surface)
    // reflects the startup TTY snapshot.
    assert.equal(ansiColorDepth({}, false), 0);
    assert.equal(ansiColorDepth({ TERM: 'xterm-256color' }, false), 2);
    assert.equal(ansiColorDepth({ TERM: 'dumb' }, true), 0);
    assert.equal(ansiColorDepth({ TMUX: '/tmp/tmux' }, true), 3);
    assert.equal(ansiColorDepth({ CI: 'true' }, true), 1);
    // CI wins over the TERM table, following Bun's check order.
    assert.equal(ansiColorDepth({ CI: '1', TERM: 'xterm-256color' }, true), 1);
    assert.equal(ansiColorDepth({ TMUX: '1', CI: '1' }, true), 3);
    for (const program of ['ghostty', 'MacTerm', 'WezTerm', 'HyperTerm', 'iTerm.app']) {
        assert.equal(ansiColorDepth({ TERM_PROGRAM: program }, true), 3, program);
    }
    assert.equal(ansiColorDepth({ COLORTERM: 'truecolor' }, true), 3);
    assert.equal(ansiColorDepth({ COLORTERM: '24bit' }, true), 3);
    assert.equal(ansiColorDepth({ TERM: 'xterm-256color' }, true), 2);
    assert.equal(ansiColorDepth({ TERM: 'xterm-256' }, true), 2);
    // Bun's exact TERM pairs: C16 entries.
    for (const term of ['st', 'hurd', 'eterm', 'gnome', 'kterm', 'putty', 'cons25', 'cygwin', 'dtterm', 'mlterm', 'console', 'jfbterm', 'konsole']) {
        assert.equal(ansiColorDepth({ TERM: term }, true), 1, term);
    }
    // Bun's exact TERM pairs: C16m entries.
    for (const term of ['mosh', 'terminator', 'xterm-ghostty', 'rxvt-unicode-24bit']) {
        assert.equal(ansiColorDepth({ TERM: term }, true), 3, term);
    }
    // Substring fallback covers common families.
    for (const term of ['screen', 'linux', 'vt100', 'rxvt', 'xterm-color', 'ansi', 'conhttp']) {
        assert.equal(ansiColorDepth({ TERM: term }, true), 1, term);
    }
    // A bare COLORTERM value still yields the 16-color floor.
    assert.equal(ansiColorDepth({ COLORTERM: 'yes' }, true), 1);
    // Unrecognized terminals report no depth, as Bun's compute_color_depth does.
    assert.equal(ansiColorDepth({ TERM: 'totally-unknown' }, true), 0);
    assert.equal(ansiColorDepth({}, true), 0);
});

test('color: ansi-16 output is deterministic against the fixed 16-color palette', () => {
    for (const [input, code] of [
        ['red', 91], ['black', 30], ['white', 97], ['green', 32], ['yellow', 93],
        ['blue', 34], ['magenta', 95], ['cyan', 96], ['gray', 90], ['silver', 37],
        ['navy', 34], ['teal', 36], ['maroon', 31], ['purple', 35], ['olive', 33],
        ['lime', 92], ['aqua', 96], ['orange', 33], ['rebeccapurple', 90],
        ['#5f87af', 90], ['#080808', 30], ['#808080', 90], ['#eeeeee', 37],
    ]) {
        assert.equal(color(input, 'ansi-16'), `\x1b[${code}m`, input);
    }
    for (const format of ['ansi-16', 'ansi_16']) {
        assert.equal(color([255, 0, 0], format), '\x1b[91m', format);
        assert.equal(color({ r: 255, g: 0, b: 0 }, format), '\x1b[91m', format);
    }
    // Alpha is ignored, matching the ansi-256 behavior.
    assert.equal(color('#ff000000', 'ansi-16'), '\x1b[91m');
    assert.equal(color('rgba(255, 0, 0, 0.5)', 'ansi-16'), '\x1b[91m');
    assert.equal(color('transparent', 'ansi-16'), '\x1b[30m');
    assert.equal(color('invalid-color', 'ansi-16'), null);
});

test('color: "ansi" picks the installed stdout depth and empty when none', () => {
    // Without the namespace bootstrap no depth provider exists: stdout is
    // presumed colorless, matching Bun's no-ANSI empty-string contract.
    assert.equal(color('red', 'ansi'), '');
    assert.equal(color('nonsense', 'ansi'), null);

    setStdoutColorDepthProvider(() => 1);
    assert.equal(color('red', 'ansi'), '\x1b[91m');
    setStdoutColorDepthProvider(() => 2);
    assert.equal(color('red', 'ansi'), '\x1b[38;5;196m');
    setStdoutColorDepthProvider(() => 3);
    assert.equal(color('red', 'ansi'), '\x1b[38;2;255;0;0m');
    setStdoutColorDepthProvider(() => 0);
    assert.equal(color('red', 'ansi'), '');
    // Parse failures stay null at every depth.
    setStdoutColorDepthProvider(() => 3);
    assert.equal(color('nonsense', 'ansi'), null);
    setStdoutColorDepthProvider(undefined);
    assert.equal(color('red', 'ansi'), '');
});
