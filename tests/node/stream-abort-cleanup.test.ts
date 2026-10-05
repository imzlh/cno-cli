import { ok, strictEqual } from 'node:assert';
import { getEventListeners } from 'node:events';
import { addAbortSignal, PassThrough, Readable, Writable } from 'node:stream';

const engine = import.meta.use('engine');
const timers = import.meta.use('timers');
const tick = (): Promise<void> => new Promise((resolve) => timers.setTimeout(resolve, 10));
const abortListeners = (signal: AbortSignal): number => getEventListeners(signal, 'abort').length;

Deno.test('stream.addAbortSignal: a shared signal releases finished and destroyed streams', async () => {
    const controller = new AbortController();
    const refs: WeakRef<Writable>[] = [];

    function createStream(finish: boolean): WeakRef<Writable> {
        const stream = Object.assign(new Writable({
            autoDestroy: false,
            write(_chunk, _encoding, callback) { callback(); },
        }), { payload: new Uint8Array(1024 * 1024) });
        addAbortSignal(controller.signal, stream);
        const ref = new WeakRef(stream);
        if (finish) stream.end();
        else stream.destroy();
        return ref;
    }

    try {
        for (let i = 0; i < 8; i++) refs.push(createStream(true));
        for (let i = 0; i < 8; i++) refs.push(createStream(false));
        await tick();
        engine.gc.run();
        await tick();
        engine.gc.run();
        strictEqual(abortListeners(controller.signal), 0);
        strictEqual(refs.filter((ref) => ref.deref() !== undefined).length, 0,
            'a live shared signal must not retain completed streams or their payloads');
    } finally {
        controller.abort();
    }
});

Deno.test('stream.addAbortSignal: readable and duplex completion removes the listener', async () => {
    const controller = new AbortController();
    const readable = new Readable({ autoDestroy: false, read() { this.push(null); } });
    const duplex = new PassThrough({ autoDestroy: false });
    addAbortSignal(controller.signal, readable);
    addAbortSignal(controller.signal, duplex);
    readable.resume();
    duplex.resume();
    duplex.end('done');
    await tick();
    strictEqual(readable.readableEnded, true);
    strictEqual(duplex.readableEnded, true);
    strictEqual(duplex.writableFinished, true);
    strictEqual(abortListeners(controller.signal), 0);
    controller.abort();
    strictEqual(readable.destroyed, false);
    strictEqual(duplex.destroyed, false);
});

Deno.test('stream.addAbortSignal: a half-finished duplex remains abortable', async () => {
    const controller = new AbortController();
    const stream = new PassThrough({ autoDestroy: false });
    const reason = new Error('request canceled');
    let error: (Error & { code?: string; cause?: unknown }) | undefined;
    stream.on('error', (value) => { error = value; });
    strictEqual(addAbortSignal(controller.signal, stream), stream);
    stream.end('unread');
    await tick();
    strictEqual(stream.writableFinished, true);
    strictEqual(stream.readableEnded, false);
    strictEqual(abortListeners(controller.signal), 1);
    controller.abort(reason);
    await tick();
    strictEqual(stream.destroyed, true);
    ok(error);
    strictEqual(error.code, 'ABORT_ERR');
    strictEqual(error.cause, reason);
    strictEqual(abortListeners(controller.signal), 0);
});

Deno.test('stream.addAbortSignal: already terminal streams do not retain abort listeners', async () => {
    const controller = new AbortController();
    const finished = new Writable({ autoDestroy: false, write(_c, _e, callback) { callback(); } });
    const destroyed = new Readable({ read() {} });
    finished.end();
    destroyed.destroy();
    await tick();
    addAbortSignal(controller.signal, finished);
    addAbortSignal(controller.signal, destroyed);
    strictEqual(abortListeners(controller.signal), 0);
    controller.abort();
    strictEqual(finished.destroyed, false);
});

Deno.test('stream.addAbortSignal: an already aborted signal still destroys the stream', async () => {
    const controller = new AbortController();
    const reason = new Error('already canceled');
    controller.abort(reason);
    const stream = new Writable({ write(_c, _e, callback) { callback(); } });
    addAbortSignal(controller.signal, stream);
    await tick();
    strictEqual(stream.destroyed, true);
    strictEqual(stream.errored?.name, 'AbortError');
    strictEqual(stream.errored?.cause, reason);
    strictEqual(abortListeners(controller.signal), 0);
});
