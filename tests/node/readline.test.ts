import { strictEqual, ok } from 'node:assert';
import * as readline from 'node:readline';
import { Readable } from 'node:stream';

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

// --- 4. rl.pause / resume are callable --------------------------------------

Deno.test('readline: pause/resume are callable', () => {
    const input = Readable.from(['x']);
    const rl = readline.createInterface(input);
    rl.pause();
    rl.resume();
    rl.close();
});

// --- 5. rl.write writes to output -------------------------------------------

Deno.test('readline: write is callable', () => {
    const input = Readable.from([]);
    const rl = readline.createInterface(input);
    rl.write('output-data');
    rl.close();
});

// --- 6. createInterface with output option ----------------------------------

Deno.test('readline: createInterface accepts output option', () => {
    const input = Readable.from([]);
    const output = new (require('node:stream').Writable)({ write(_c, _e, cb) { cb(); } });
    const rl = readline.createInterface({ input, output });
    ok(rl);
    rl.close();
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
