import { deepStrictEqual, strictEqual } from 'node:assert';
import { PassThrough } from 'node:stream';
import { createInterface } from '../../cno/src/node/readline/mod';

Deno.test('readline: close detaches the constructor abort listener', () => {
    const controller = new AbortController();
    const { signal } = controller;
    const listeners = new Set<EventListenerOrEventListenerObject | null>();
    const add = signal.addEventListener.bind(signal);
    const remove = signal.removeEventListener.bind(signal);
    signal.addEventListener = (...[type, listener, options]: Parameters<AbortSignal['addEventListener']>) => {
        if (type === 'abort') listeners.add(listener);
        add(type, listener, options);
    };
    signal.removeEventListener = (...[type, listener, options]: Parameters<AbortSignal['removeEventListener']>) => {
        if (type === 'abort') listeners.delete(listener);
        remove(type, listener, options);
    };
    const input = new PassThrough();
    const rl = createInterface({ input, signal });
    try {
        strictEqual(listeners.size, 1);
        rl.close();
        strictEqual(listeners.size, 0);
        strictEqual(input.listenerCount('data'), 0);
        controller.abort();
        strictEqual(rl.closed, true);
    } finally {
        rl.close();
        input.destroy();
    }
});

Deno.test('readline: resuming after an input error does not duplicate listeners', () => {
    const input = new PassThrough();
    const rl = createInterface({ input });
    const errors: string[] = [];
    rl.on('error', (error: Error) => errors.push(error.message));
    try {
        input.emit('error', new Error('read failed'));
        rl.pause();
        rl.resume();
        input.emit('error', new Error('read failed again'));
        deepStrictEqual(errors, ['read failed', 'read failed again']);
        strictEqual(input.listenerCount('data'), 1);
        strictEqual(input.listenerCount('error'), 1);
        rl.close();
        strictEqual(input.listenerCount('data'), 0);
        strictEqual(input.listenerCount('end'), 0);
        strictEqual(input.listenerCount('error'), 0);
    } finally {
        rl.close();
        input.destroy();
    }
});

Deno.test('readline: an already aborted interface does not write its prompt', () => {
    const input = new PassThrough();
    const output = new PassThrough();
    const controller = new AbortController();
    controller.abort();
    const rl = createInterface({ input, output, signal: controller.signal, terminal: true, prompt: '> ' });
    try {
        strictEqual(rl.closed, true);
        strictEqual(input.listenerCount('data'), 0);
        strictEqual(output.readableLength, 0);
    } finally {
        rl.close();
        input.destroy();
        output.destroy();
    }
});
