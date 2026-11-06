import { rejects, strictEqual, throws } from 'node:assert';
import Bun, { stderr, stdin, stdout } from 'bun';
import { withTempDir } from '../_helpers/temp.ts';
import { join } from 'node:path';
import { existsSync, readFileSync } from 'node:fs';

Deno.test({ name: 'bun.file.writer: buffered writes flush through end()', timeout: 10000 }, async () => {
    await withTempDir('file-sink', (dir) => {
        const path = join(dir, 'sink.txt');
        const sink = Bun.file(path).writer();
        strictEqual(sink.write('hello '), 6);
        strictEqual(sink.write(new Uint8Array([119, 111])), 2); // "wo"
        strictEqual(sink.flush(), 8);
        // The file is readable before end(); end() contributes no more bytes.
        strictEqual(readFileSync(path, 'utf8'), 'hello wo');
        strictEqual(sink.write('rld'), 3);
        strictEqual(sink.end(), 3);
        strictEqual(readFileSync(path, 'utf8'), 'hello world');
        throws(() => sink.write('late'), /already closed/);
        strictEqual(sink.end(), 0);
    });
});

Deno.test({ name: 'bun.file.writer: highWaterMark commits eagerly and options are validated', timeout: 10000 }, async () => {
    await withTempDir('file-sink-hwm', (dir) => {
        const path = join(dir, 'eager.txt');
        const sink = Bun.file(path).writer({ highWaterMark: 4 });
        sink.write('abc'); // below the mark: still buffered
        strictEqual(readFileSync(path, 'utf8'), '');
        sink.write('d'); // reaches the mark: committed
        strictEqual(readFileSync(path, 'utf8'), 'abcd');
        sink.end();
        throws(() => Bun.file(path).writer('x' as never), TypeError);
        const permissive = Bun.file(join(dir, 'permissive.txt')).writer({ highWaterMark: -1 });
        permissive.start('ignored' as never);
        strictEqual(permissive.write('ok'), 2);
        strictEqual(permissive.end(), 2);
    });
});

Deno.test({ name: 'bun.file.writer: overwrites without truncation and end(error) flushes pending data', timeout: 10000 }, async () => {
    await withTempDir('file-sink-trunc', async (dir) => {
        const path = join(dir, 'trunc.txt');
        await Bun.write(path, 'previous content');
        const sink = Bun.file(path).writer();
        strictEqual(sink.flush(), 0);
        // Truncation happens on the first real flush.
        sink.write('new');
        sink.flush();
        strictEqual(readFileSync(path, 'utf8'), 'newvious content');

        const errorPath = join(dir, 'error.txt');
        const failing = Bun.file(errorPath).writer();
        strictEqual(existsSync(errorPath), true);
        failing.write('dropped');
        const error = new Error('sink failure');
        strictEqual(failing.end(error), 7);
        // Double end is an idempotent no-op, matching the subprocess FileSink.
        strictEqual(failing.end(new Error('again')), 0);
        strictEqual(readFileSync(errorPath, 'utf8'), 'dropped');
    });
});

Deno.test({ name: 'bun.file.writer: rejects Blob chunks and creates the target eagerly', timeout: 10000 }, async () => {
    await withTempDir('file-sink-inputs', (dir) => {
        const path = join(dir, 'created.txt');
        const sink = Bun.file(path).writer();
        strictEqual(existsSync(path), true);
        strictEqual(readFileSync(path, 'utf8'), '');
        throws(() => sink.write(new Blob(['not accepted']) as never), {
            name: 'TypeError',
            message: 'write() expects a string, ArrayBufferView, or ArrayBuffer',
        });
        strictEqual(sink.write(new DataView(new Uint8Array([1, 2]).buffer)), 2);
        strictEqual(sink.end(null as never), 2);
        strictEqual(readFileSync(path).toString('hex'), '0102');
    });
});

Deno.test({ name: 'bun.write accepts a ReadableStream body', timeout: 10000 }, async () => {
    await withTempDir('write-stream', async (dir) => {
        const path = join(dir, 'streamed.txt');
        const source = new ReadableStream<Uint8Array>({
            start(controller) {
                for (const chunk of ['st', 'rea', 'm']) controller.enqueue(new TextEncoder().encode(chunk));
                controller.close();
            },
        });
        const written = await Bun.write(path, source);
        strictEqual(written, 6);
        strictEqual(readFileSync(path, 'utf8'), 'stream');
    });
});

Deno.test({ name: 'bun.stdio.writer: incremental writes over the fixed descriptor', timeout: 5000 }, async () => {
    const sink = stdout.writer({ highWaterMark: 4 });
    // Both writes cross the mark, so each commits eagerly.
    strictEqual(sink.write('sink'), 4);
    strictEqual(sink.write('-probe'), 6);
    strictEqual(sink.flush(), 0); // nothing left buffered
    strictEqual(sink.end(), 0); // the fd stays open
    strictEqual(sink.end(), 0);
    throws(() => stdin.writer(), /not writable/);
    await rejects(() => stderr.text(), /not readable/);
});
