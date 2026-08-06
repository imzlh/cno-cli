/**
 * Unit tests for HistoryStore — drives the real shipped module via sqlite3.
 */
import { strictEqual, ok, deepStrictEqual } from 'node:assert';
import { join } from 'node:path';
import { withTempDir } from '../_helpers/temp.ts';
import {
    HistoryStore,
    HISTORY_DB_NAME,
    HISTORY_LIMIT,
} from '../../src/commands/repl/history.ts';
import { JSColorizer } from '../../src/commands/repl/colorizer.ts';
import { CompletionEngine } from '../../src/commands/repl/completion.ts';

const fs = import.meta.use('fs');
const engine = import.meta.use('engine');
const sqlite3 = import.meta.use('sqlite3');

function stripAnsi(value: string): string {
    return value.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '');
}

async function runRepl(input: string, cwd?: string, env?: Record<string, string>): Promise<string> {
    const child = new Deno.Command(Deno.execPath().replace(/ \(deleted\)$/, ''), {
        args: ['repl'],
        cwd,
        stdin: 'piped',
        stdout: 'piped',
        stderr: 'piped',
        env: { CTS_SILENT: 'true', ...env },
    }).spawn();
    const writer = child.stdin.getWriter();
    await writer.write(new TextEncoder().encode(input));
    await writer.close();
    const output = await child.output();
    return stripAnsi(`${new TextDecoder().decode(output.stdout)}\n${new TextDecoder().decode(output.stderr)}`);
}

function readDbLines(path: string): string[] {
    const db = sqlite3.open(path, sqlite3.O_READONLY);
    try {
        const rows = db.prepare('SELECT line FROM history ORDER BY id ASC').all();
        return rows
            .map((r: { line?: unknown }) => r.line)
            .filter((l: unknown): l is string => typeof l === 'string');
    } finally {
        try { db.close(); } catch { /* */ }
    }
}

Deno.test('HistoryStore: append writes a row immediately without close', async () => {
    await withTempDir('hist-store-immediate', (root) => {
        const path = join(root, HISTORY_DB_NAME);
        const store = new HistoryStore({ path, limit: 100 });
        ok(store.append('first line'));
        // Re-open a second connection while the first store is still open.
        const lines = readDbLines(path);
        deepStrictEqual(lines, ['first line']);
        store.close();
    });
});

Deno.test('HistoryStore: load on open recalls prior session lines', async () => {
    await withTempDir('hist-store-reload', (root) => {
        const path = join(root, HISTORY_DB_NAME);
        {
            const a = new HistoryStore({ path });
            a.append('alpha');
            a.append('beta');
            a.close();
        }
        const b = new HistoryStore({ path });
        deepStrictEqual(b.lines(), ['alpha', 'beta']);
        b.close();
    });
});

Deno.test('HistoryStore: consecutive duplicates are skipped', async () => {
    await withTempDir('hist-store-dedup', (root) => {
        const path = join(root, HISTORY_DB_NAME);
        const store = new HistoryStore({ path });
        ok(store.append('x'));
        ok(!store.append('x'));
        ok(store.append('y'));
        deepStrictEqual(store.lines(), ['x', 'y']);
        deepStrictEqual(readDbLines(path), ['x', 'y']);
        store.close();
    });
});

Deno.test('HistoryStore: migrateFromTextFile imports legacy text once', async () => {
    await withTempDir('hist-store-migrate', (root) => {
        const path = join(root, HISTORY_DB_NAME);
        const text = join(root, '.cno_history');
        fs.writeFile(text, engine.encodeString('old one\r\nold two\r\n'), 0o600);
        const store = new HistoryStore({ path });
        store.migrateFromTextFile(text);
        deepStrictEqual(store.lines(), ['old one', 'old two']);
        deepStrictEqual(readDbLines(path), ['old one', 'old two']);
        // Second migrate is a no-op when memory already has lines.
        store.migrateFromTextFile(text);
        deepStrictEqual(store.lines(), ['old one', 'old two']);
        store.close();
    });
});

Deno.test('HistoryStore: prev/next navigate in-memory list', () => {
    const store = new HistoryStore({ path: null });
    store.append('a');
    store.append('b');
    store.resetCursor();
    strictEqual(store.prev('draft'), 'b');
    strictEqual(store.prev('draft'), 'a');
    strictEqual(store.next(), 'b');
    strictEqual(store.next(), 'draft');
    store.close();
});

Deno.test('HistoryStore: limit prunes memory and DB', async () => {
    await withTempDir('hist-store-limit', (root) => {
        const path = join(root, HISTORY_DB_NAME);
        const store = new HistoryStore({ path, limit: 3 });
        store.append('1');
        store.append('2');
        store.append('3');
        store.append('4');
        deepStrictEqual(store.lines(), ['2', '3', '4']);
        // After prune, DB should not retain more than limit newest.
        const dbLines = readDbLines(path);
        ok(dbLines.length <= 3, `expected ≤3 rows, got ${dbLines.length}: ${dbLines.join(',')}`);
        ok(dbLines.includes('4'));
        store.close();
        strictEqual(HISTORY_LIMIT, 1000);
    });
});

Deno.test('REPL colorizer: non-spanning syntax is reported as invalid', () => {
    const colorizer = new JSColorizer();
    ok(colorizer.colorize("'unterminated").invalid);
    ok(colorizer.colorize('/unterminated').invalid);
    ok(colorizer.colorize('({]').invalid);
    strictEqual(colorizer.colorize('/* unterminated').state, '/');
    strictEqual(colorizer.colorize('`unterminated').state, '`');
});

Deno.test('REPL completion: ordinary paths work and throwing accessors are contained', () => {
    const completion = new CompletionEngine();
    ok(completion.getCompletions('console.lo', 10).completions.includes('log'));
    const key = '__cno_repl_completion_throwing__';
    Object.defineProperty(globalThis, key, {
        configurable: true,
        get() { throw new Error('completion getter'); },
    });
    try {
        deepStrictEqual(completion.getCompletions(`${key}.`, key.length + 1).completions, []);
    } finally {
        delete (globalThis as Record<string, unknown>)[key];
    }
});

Deno.test({ name: 'REPL serializes piped lines and preserves EOF order', timeout: 10000 }, async () => {
    const output = await runRepl(
        'globalThis.replOrder = []\n' +
        'await new Promise(r => setTimeout(() => { replOrder.push(1); r(0) }, 30))\n' +
        'replOrder.push(2)\n' +
        'replOrder\n' +
        '.q\n',
    );
    // Node's inspect (and cno's) renders an array with inner padding:
    // `[ 1, 2 ]`, not `[1, 2]`. The intent here is the ordering — the awaited
    // timer must land before the next piped line — not the spacing.
    ok(output.includes('[ 1, 2 ]'), output);
});

Deno.test({ name: 'REPL .load preserves the supplied TypeScript path', timeout: 10000 }, async () => {
    await withTempDir('repl-load', async (root) => {
        await Deno.writeTextFile(join(root, 'loaded.ts'), 'globalThis.replLoaded = 17;\n');
        const output = await runRepl('.load loaded.ts\nreplLoaded\n.q\n', root, { HOME: root });
        ok(output.includes('17'), output);
        ok(!output.includes('loaded.ts.js'), output);
    });
});

Deno.test({ name: 'REPL recovers after invalid syntax and accepts the next line', timeout: 10000 }, async () => {
    const output = await runRepl("'unterminated\n1 + 2\n.q\n");
    ok(output.includes('TransformError'), output);
    ok(output.includes('\n3\n'), output);
});

Deno.test({ name: 'REPL completion lists only after a second Tab', timeout: 10000 }, async () => {
    const oneTab = await runRepl('con\t\n.q\n');
    const twoTabs = await runRepl('con\t\t\n.q\n');
    ok(!oneTab.includes('confirm      console      constructor'), oneTab);
    ok(twoTabs.includes('confirm      console      constructor'), twoTabs);
});
