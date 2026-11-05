import { rejects, strictEqual, throws } from 'node:assert';
import Bun, { stderr, stdin, stdout } from 'bun';
import { withTempDir } from '../_helpers/temp.ts';
import { join } from 'node:path';
import { readFileSync } from 'node:fs';

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
        throws(() => readFileSync(path, 'utf8'), /ENOENT/);
        sink.write('d'); // reaches the mark: committed
        strictEqual(readFileSync(path, 'utf8'), 'abcd');
        sink.end();
        throws(() => Bun.file(path).writer({ highWaterMark: -1 }), RangeError);
        throws(() => Bun.file(path).writer('x' as never), TypeError);
        throws(() => sink.start({ highWaterMark: -1 }), RangeError);
    });
});

Deno.test({ name: 'bun.file.writer: overwrites without truncation and end(error) discards pending data', timeout: 10000 }, async () => {
    await withTempDir('file-sink-trunc', async (dir) => {
        const path = join(dir, 'trunc.txt');
        await Bun.write(path, 'previous content');
        const sink = Bun.file(path).writer();
        strictEqual(sink.flush(), 0);
        // Truncation happens on the first real flush.
        sink.write('new');
        sink.flush();
        strictEqual(readFileSync(path, 'utf8'), 'newvious content');

        const failing = Bun.file(join(dir, 'error.txt')).writer();
        failing.write('dropped');
        const error = new Error('sink failure');
        strictEqual(failing.end(error), 0);
        // Double end is an idempotent no-op, matching the subprocess FileSink.
        strictEqual(failing.end(new Error('again')), 0);
        // end(error) never opened or flushed: the file does not exist.
        throws(() => readFileSync(join(dir, 'error.txt'), 'utf8'), /ENOENT/);
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
