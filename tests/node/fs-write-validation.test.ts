/**
 * Regression tests for two destructive fs behaviours.
 *
 * 1. Invalid `data` (a number, a plain object, a boolean) fell through to a
 *    zero-length view, so writeFile/writeFileSync/appendFile TRUNCATED an
 *    existing file to empty and resolved successfully. Node throws
 *    ERR_INVALID_ARG_TYPE and leaves the file untouched.
 * 2. `parseFlags` was a no-op, so the native layer matched flag *characters*.
 *    `open(file, 'rw')` — which Node rejects — contained a `w` and therefore
 *    opened O_TRUNC, silently destroying the file's contents.
 *
 * Also covers `fsp.writeFile` with an Iterable/AsyncIterable/stream, which Node
 * supports and which previously produced an empty file with no error.
 *
 * Expectations captured from real `node` v24.
 */
import { rejects, strictEqual, throws } from 'node:assert';
import * as fs from 'node:fs';
import * as fsp from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { Readable } from 'node:stream';

function tmp(): string {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'fs-wv-'));
}

const BAD_DATA: [string, unknown][] = [
    ['number', 42],
    ['boolean', true],
    ['plain object', { a: 1 }],
    ['object with no keys', {}],
];

Deno.test('fs: writeFile rejects invalid data and leaves the file intact', async () => {
    const dir = tmp();
    try {
        for (const [label, data] of BAD_DATA) {
            const file = path.join(dir, 'keep.txt');
            fs.writeFileSync(file, 'ORIGINAL');
            await rejects(
                () => fsp.writeFile(file, data as string),
                (err: NodeJS.ErrnoException) => {
                    strictEqual(err.code, 'ERR_INVALID_ARG_TYPE', `${label}: wrong code`);
                    return true;
                },
                `writeFile must reject ${label}`,
            );
            strictEqual(
                fs.readFileSync(file, 'utf8'),
                'ORIGINAL',
                `writeFile(${label}) must not truncate the target`,
            );
        }
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

Deno.test('fs: writeFileSync and appendFile reject invalid data', () => {
    const dir = tmp();
    try {
        for (const [label, data] of BAD_DATA) {
            const file = path.join(dir, 'sync.txt');
            fs.writeFileSync(file, 'ORIGINAL');
            throws(
                () => fs.writeFileSync(file, data as string),
                (err: NodeJS.ErrnoException) => err.code === 'ERR_INVALID_ARG_TYPE',
                `writeFileSync must reject ${label}`,
            );
            strictEqual(fs.readFileSync(file, 'utf8'), 'ORIGINAL', `${label} truncated the file`);
            throws(
                () => fs.appendFileSync(file, data as string),
                (err: NodeJS.ErrnoException) => err.code === 'ERR_INVALID_ARG_TYPE',
                `appendFileSync must reject ${label}`,
            );
            strictEqual(fs.readFileSync(file, 'utf8'), 'ORIGINAL', `${label} altered the file`);
        }
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

Deno.test('fs: valid data types still write correctly', async () => {
    const dir = tmp();
    try {
        const f = (n: string) => path.join(dir, n);
        await fsp.writeFile(f('s'), 'str');
        strictEqual(fs.readFileSync(f('s'), 'utf8'), 'str');
        await fsp.writeFile(f('b'), Buffer.from('buf'));
        strictEqual(fs.readFileSync(f('b'), 'utf8'), 'buf');
        await fsp.writeFile(f('u'), new Uint8Array([65, 66]));
        strictEqual(fs.readFileSync(f('u'), 'utf8'), 'AB');
        await fsp.writeFile(f('dv'), new DataView(new Uint8Array([67, 68]).buffer));
        strictEqual(fs.readFileSync(f('dv'), 'utf8'), 'CD');
        await fsp.writeFile(f('ab'), new Uint8Array([69]).buffer);
        strictEqual(fs.readFileSync(f('ab'), 'utf8'), 'E');
        await fsp.writeFile(f('hex'), '4142', 'hex');
        strictEqual(fs.readFileSync(f('hex'), 'utf8'), 'AB');
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

Deno.test('fs: promises writeFile accepts iterables, async iterables and streams', async () => {
    const dir = tmp();
    try {
        const f = (n: string) => path.join(dir, n);

        await fsp.writeFile(f('agen'), (async function* () { yield 'x'; yield 'y'; })());
        strictEqual(fs.readFileSync(f('agen'), 'utf8'), 'xy', 'async generator content lost');

        await fsp.writeFile(f('gen'), (function* () { yield 'x'; yield 'y'; })());
        strictEqual(fs.readFileSync(f('gen'), 'utf8'), 'xy', 'sync generator content lost');

        await fsp.writeFile(f('arr'), ['a', 'b'] as unknown as string);
        strictEqual(fs.readFileSync(f('arr'), 'utf8'), 'ab', 'array iterable content lost');

        await fsp.writeFile(f('stream'), Readable.from(['s1', 's2']) as unknown as string);
        strictEqual(fs.readFileSync(f('stream'), 'utf8'), 's1s2', 'stream content lost');

        await fsp.writeFile(f('bufs'), [Buffer.from('p'), Buffer.from('q')] as unknown as string);
        strictEqual(fs.readFileSync(f('bufs'), 'utf8'), 'pq', 'buffer chunks lost');

        // An empty iterable yields an empty file, not an error.
        await fsp.writeFile(f('none'), (async function* () { })());
        strictEqual(fs.readFileSync(f('none'), 'utf8'), '');
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

const BAD_FLAGS = ['zz', '', 'rw', 'q+', 'RW'];

Deno.test('fs: open rejects invalid flag strings without touching the file', async () => {
    const dir = tmp();
    try {
        for (const flag of BAD_FLAGS) {
            const file = path.join(dir, 'flags.txt');
            fs.writeFileSync(file, 'ORIGINAL');
            await rejects(
                () => fsp.open(file, flag),
                (err: NodeJS.ErrnoException) => {
                    strictEqual(err.code, 'ERR_INVALID_ARG_VALUE', `flag ${JSON.stringify(flag)}: wrong code`);
                    return true;
                },
                `open must reject flag ${JSON.stringify(flag)}`,
            );
            strictEqual(
                fs.readFileSync(file, 'utf8'),
                'ORIGINAL',
                `open(${JSON.stringify(flag)}) must not truncate the file`,
            );
        }
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

Deno.test('fs: openSync rejects invalid flag strings without truncating', () => {
    const dir = tmp();
    try {
        for (const flag of BAD_FLAGS) {
            const file = path.join(dir, 'flags-sync.txt');
            fs.writeFileSync(file, 'ORIGINAL');
            throws(
                () => fs.openSync(file, flag as 'r'),
                (err: NodeJS.ErrnoException) => err.code === 'ERR_INVALID_ARG_VALUE',
                `openSync must reject flag ${JSON.stringify(flag)}`,
            );
            strictEqual(fs.readFileSync(file, 'utf8'), 'ORIGINAL', `flag ${flag} truncated the file`);
        }
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

Deno.test('fs: every documented flag string is still accepted', async () => {
    const dir = tmp();
    try {
        const file = path.join(dir, 'ok-flags.txt');
        fs.writeFileSync(file, 'seed');
        // Read-ish and append-ish flags must not be rejected by the validator.
        for (const flag of ['r', 'r+', 'rs', 'sr', 'rs+', 'sr+', 'a', 'a+', 'as', 'as+']) {
            const fh = await fsp.open(file, flag);
            await fh.close();
        }
        // Numeric flags bypass string validation entirely.
        const fh = await fsp.open(file, fs.constants.O_RDONLY);
        await fh.close();
        // Truncating/exclusive flags on a fresh path.
        for (const flag of ['w', 'w+', 'wx', 'xw', 'wx+', 'xw+', 'ax', 'xa', 'ax+', 'xa+']) {
            const p = path.join(dir, `f-${Buffer.from(flag).toString('hex')}`);
            const h = await fsp.open(p, flag);
            await h.close();
        }
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});
