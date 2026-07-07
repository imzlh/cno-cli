import { strictEqual, ok } from 'node:assert';
import * as readline from 'node:readline';
import * as readlinePromises from 'node:readline/promises';
import { PassThrough, Readable, Writable } from 'node:stream';

// --- 1. createInterface accepts a Readable stream ---------------------------

Deno.test('readline: createInterface accepts a Readable stream', () => {
    const input = Readable.from(['line1', 'line2']);
    const rl = readline.createInterface(input);
    ok(rl, 'createInterface must return an Interface');
    rl.close();
});

// --- 2. createInterface emits 'line' for each input ------------------------

Deno.test('readline: createInterface emits line events', async () => {
    const input = Readable.from(['a\nb\nc\n']);
    const rl = readline.createInterface(input);
    const lines: string[] = [];
    rl.on('line', (l) => lines.push(l));
    await new Promise<void>((resolve) => rl.on('close', () => resolve()));
    strictEqual(lines.length, 3);
    strictEqual(lines.join(','), 'a,b,c');
    rl.close();
});

Deno.test('readline: createInterface normalizes CRLF and flushes unterminated final line', async () => {
    const input = Readable.from(['a\r\nb\nlast']);
    const rl = readline.createInterface({ input, crlfDelay: Infinity });
    const lines: string[] = [];
    rl.on('line', (line) => lines.push(line));
    await new Promise<void>((resolve) => rl.on('close', () => resolve()));
    strictEqual(lines.join(','), 'a,b,last');
});

// --- 3. rl.question writes prompt and resolves on answer --------------------

Deno.test('readline: question resolves with answer', async () => {
    const input = Readable.from(['my-answer\n']);
    const rl = readline.createInterface(input);
    const answer = await new Promise<string>((resolve) => {
        rl.question('prompt> ', resolve);
    });
    rl.close();
    strictEqual(answer, 'my-answer');
});

Deno.test('readline: question writes prompt to provided output', async () => {
    let out = '';
    const input = Readable.from(['answer\n']);
    const output = new Writable({ write(c: Buffer, _e, cb) { out += c.toString(); cb(); } });
    const rl = readline.createInterface({ input, output, terminal: false });
    const answer = await new Promise<string>((resolve) => rl.question('prompt> ', resolve));
    rl.close();
    strictEqual(answer, 'answer');
    strictEqual(out, 'prompt> ');
});

// --- 4. rl.pause / resume are callable --------------------------------------

Deno.test('readline: pause/resume toggle input paused state', () => {
    const input = new PassThrough();
    const rl = readline.createInterface({ input, terminal: false });
    strictEqual(input.isPaused(), false);
    rl.pause();
    strictEqual(input.isPaused(), true);
    rl.resume();
    strictEqual(input.isPaused(), false);
    rl.close();
});

Deno.test('readline: pause and resume emit once per state transition', () => {
    const input = new PassThrough();
    const rl = readline.createInterface({ input, terminal: false });
    const events: string[] = [];
    rl.on('pause', () => events.push('pause'));
    rl.on('resume', () => events.push('resume'));

    rl.pause();
    rl.pause();
    rl.resume();
    rl.resume();
    rl.close();

    strictEqual(events.join(','), 'pause,resume');
});

// --- 5. rl.write writes to output -------------------------------------------

Deno.test('readline: write echoes data to terminal output', async () => {
    let out = '';
    const input = new PassThrough();
    const output = new Writable({ write(c: Buffer, _e, cb) { out += c.toString(); cb(); } });
    const rl = readline.createInterface({ input, output, terminal: true });
    rl.write('output-data');
    await new Promise((resolve) => setTimeout(resolve, 20));
    rl.close();
    strictEqual(out, 'output-data');
});

// --- 6. createInterface with output option ----------------------------------

Deno.test('readline: createInterface accepts output option', () => {
    const input = Readable.from([]);
    const output = new Writable({ write(_c, _e, cb) { cb(); } });
    const rl = readline.createInterface({ input, output });
    ok(rl);
    rl.close();
});

Deno.test('readline: prompt uses current prompt string in non-terminal mode', async () => {
    let out = '';
    const output = new Writable({ write(c: Buffer, _e, cb) { out += c.toString(); cb(); } });
    const rl = readline.createInterface({ input: Readable.from([]), output, prompt: 'p> ', terminal: false });
    rl.prompt();
    rl.setPrompt('q> ');
    rl.prompt();
    await new Promise((r) => setTimeout(r, 0));
    rl.close();
    strictEqual(out, 'p> q> ');
});

Deno.test('readline: getPrompt returns configured prompt string', () => {
    const rl = readline.createInterface({ input: Readable.from([]), output: new Writable({ write(_c, _e, cb) { cb(); } }), prompt: 'p> ', terminal: false });
    try {
        strictEqual(rl.getPrompt(), 'p> ');
    } finally {
        rl.close();
    }
});

Deno.test('readline: write updates line state in terminal mode', async () => {
    const input = new PassThrough();
    const output = new Writable({ write(_c, _e, cb) { cb(); } });
    const rl = readline.createInterface({ input, output, terminal: true });
    try {
        strictEqual(rl.line, '');
        rl.write('abc');
        await new Promise((resolve) => setTimeout(resolve, 20));
        strictEqual(rl.line, 'abc');
    } finally {
        rl.close();
    }
});

// --- 7. Interface extends EventEmitter --------------------------------------

Deno.test('readline: Interface extends EventEmitter', () => {
    const input = Readable.from([]);
    const rl = readline.createInterface(input);
    ok(typeof rl.on === 'function');
    ok(typeof rl.emit === 'function');
    rl.close();
});

// --- 8. rl.close emits 'close' ---------------------------------------------

Deno.test('readline: close emits close event', async () => {
    const input = Readable.from([]);
    const rl = readline.createInterface(input);
    let closed = false;
    rl.on('close', () => { closed = true; });
    rl.close();
    await new Promise((r) => setTimeout(r, 20));
    ok(closed, 'close must emit');
});

Deno.test('readline: close is idempotent and removes input listeners', () => {
    const input = new PassThrough();
    const rl = readline.createInterface({ input, terminal: false });
    let closed = 0;
    rl.on('close', () => { closed++; });

    ok(input.listenerCount('data') > 0);
    ok(input.listenerCount('end') > 0);
    ok(input.listenerCount('close') > 0);
    ok(input.listenerCount('error') > 0);

    rl.close();
    rl.close();

    strictEqual(closed, 1);
    strictEqual(input.listenerCount('data'), 0);
    strictEqual(input.listenerCount('end'), 0);
    strictEqual(input.listenerCount('close'), 0);
    strictEqual(input.listenerCount('error'), 0);
});

Deno.test('readline: clear helpers write ANSI control sequences', async () => {
    let out = '';
    const output = new Writable({ write(c: Buffer, _e, cb) { out += c.toString(); cb(); } });

    await new Promise<void>((resolve) => readline.clearLine(output, 0, resolve));
    await new Promise<void>((resolve) => readline.clearScreenDown(output, resolve));
    await new Promise<void>((resolve) => readline.cursorTo(output, 3, undefined, resolve));
    await new Promise<void>((resolve) => readline.moveCursor(output, -2, 1, resolve));

    strictEqual(out, '\x1b[2K\x1b[0J\x1b[4G\x1b[2D\x1b[1B');
});

Deno.test('readline upstream: promises interface is async iterable over input lines', async () => {
    const input = Readable.from(['import rl from "node:readline/promises";\n', 'for await (const line of rl) {}\n']);
    const rl = readlinePromises.createInterface({ input });
    const lines: string[] = [];
    for await (const line of rl) {
        lines.push(line);
    }

    strictEqual(lines.join('\n'), 'import rl from "node:readline/promises";\nfor await (const line of rl) {}');
});

Deno.test('readline upstream: callback interface is async iterable over input lines', async () => {
    const input = Readable.from(['\n    l1\n    l2\n    l3\n']);
    const rl = readline.createInterface({ input });
    const lines: string[] = [];
    for await (const line of rl) lines.push(line.trim());

    strictEqual(lines.filter(Boolean).join(','), 'l1,l2,l3');
});
