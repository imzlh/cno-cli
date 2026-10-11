import { strictEqual } from 'node:assert';
import { ChildProcessImpl } from '../../cno/src/node/child_process/child.ts';
import { waitStreamEnd } from '../../cno/src/node/child_process/_shared.ts';
import { Readable } from '../../cno/src/node/stream/mod.ts';

for (const completion of ['destroy', 'eof', 'error'] as const) {
    Deno.test({ name: `child_process: ${completion} closes the native output pipe`, timeout: 1000 }, async () => {
        let closes = 0;
        const pipe = {
            startRead() {},
            stopRead() {},
            close() { closes++; },
        } as unknown as CModuleStreams.Pipe;
        const stream = new ChildProcessImpl()._createReadable(pipe);
        const closed = new Promise<void>(resolve => stream.once('close', resolve));
        let errors = 0;
        stream.on('error', () => { errors++; });

        if (completion === 'destroy') stream.destroy();
        else if (completion === 'eof') pipe.onread(null, undefined);
        else pipe.onread(undefined, new Error('pipe read failed') as CModuleError.Error);

        await closed;
        stream.destroy();
        strictEqual(closes, 1);
        strictEqual(errors, completion === 'error' ? 1 : 0);
        strictEqual(stream.readableEnded, completion === 'eof');
    });
}

for (const event of ['end', 'close', 'error'] as const) {
    Deno.test(`child_process: ${event} releases all output completion listeners`, async () => {
        const stream = new Readable({ read() {} });
        const pending = waitStreamEnd(stream);
        stream.emit(event, new Error('closed'));
        await pending;
        for (const name of ['end', 'close', 'error']) {
            strictEqual(stream.listenerCount(name), 0, name);
        }
        stream.destroy();
    });
}
