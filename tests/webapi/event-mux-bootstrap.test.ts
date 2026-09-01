import { strictEqual } from 'node:assert';
import { installWebApiEventReceiver } from '../../cno/src/webapi/event-mux-bootstrap.ts';

const muxUrl = new URL(
    '../../../cts/src/runtime/event-mux',
    new URL('../../cno/src/webapi/event-mux-bootstrap.ts', import.meta.url),
).href;

const receiver = () => undefined;
const muxSlot = Symbol.for('cno.engine.eventMux.v1');

async function withoutMuxRegistry(fn: () => Promise<void>): Promise<void> {
    const prior = Reflect.get(globalThis, muxSlot);
    try {
        Reflect.set(globalThis, muxSlot, undefined);
        await fn();
    } finally {
        Reflect.set(globalThis, muxSlot, prior);
    }
}

Deno.test('webapi event mux: falls back only when the mux module is absent', async () => {
    let standaloneCalls = 0;
    const missing = Object.assign(new Error('module missing'), {
        code: 'ERR_MODULE_NOT_FOUND',
        url: muxUrl,
    });

    await withoutMuxRegistry(async () => {
        await installWebApiEventReceiver(receiver, () => { standaloneCalls++; }, async () => {
            throw missing;
        });
    });

    strictEqual(standaloneCalls, 1);
});

Deno.test('webapi event mux: accepts the legacy structured missing-module code', async () => {
    let standaloneCalls = 0;
    const missing = Object.assign(new Error('module missing'), {
        code: 'MODULE_NOT_FOUND',
        url: muxUrl,
    });

    await withoutMuxRegistry(async () => {
        await installWebApiEventReceiver(receiver, () => { standaloneCalls++; }, async () => {
            throw missing;
        });
    });

    strictEqual(standaloneCalls, 1);
});

Deno.test('webapi event mux: a different loader failure does not replace the receiver', async () => {
    let standaloneCalls = 0;
    const failure = Object.assign(new Error('dependency missing'), {
        code: 'ERR_MODULE_NOT_FOUND',
        url: 'file:///other-module.ts',
    });
    let thrown: unknown;

    try {
        await installWebApiEventReceiver(receiver, () => { standaloneCalls++; }, async () => {
            throw failure;
        });
    } catch (error) {
        thrown = error;
    }

    strictEqual(thrown, failure);
    strictEqual(standaloneCalls, 0);
});

Deno.test('webapi event mux: a present registry prevents a raw fallback', async () => {
    const prior = Reflect.get(globalThis, muxSlot);
    const missing = Object.assign(new Error('module missing'), {
        code: 'ERR_MODULE_NOT_FOUND',
        url: muxUrl,
    });
    let standaloneCalls = 0;
    let thrown: unknown;

    try {
        Reflect.set(globalThis, muxSlot, {});
        try {
            await installWebApiEventReceiver(receiver, () => { standaloneCalls++; }, async () => {
                throw missing;
            });
        } catch (error) {
            thrown = error;
        }
    } finally {
        Reflect.set(globalThis, muxSlot, prior);
    }

    strictEqual(thrown, missing);
    strictEqual(standaloneCalls, 0);
});

Deno.test('webapi event mux: installs through the mux when it loads', async () => {
    let standaloneCalls = 0;
    let installed: unknown[] = [];

    await installWebApiEventReceiver(receiver, () => { standaloneCalls++; }, async () => ({
        WEBAPI_ROLE: 'webapi',
        PRIORITY_WEBAPI: 100,
        installEventReceiver(...args) {
            installed = args;
            return () => {};
        },
    }));

    strictEqual(installed[0], 'webapi');
    strictEqual(installed[1], receiver);
    strictEqual(installed[2], 100);
    strictEqual(standaloneCalls, 0);
});

Deno.test('webapi event mux: an install failure does not fall back to onEvent', async () => {
    let standaloneCalls = 0;
    const failure = new Error('install failed');
    let thrown: unknown;

    try {
        await installWebApiEventReceiver(receiver, () => { standaloneCalls++; }, async () => ({
            WEBAPI_ROLE: 'webapi',
            PRIORITY_WEBAPI: 100,
            installEventReceiver() { throw failure; },
        }));
    } catch (error) {
        thrown = error;
    }

    strictEqual(thrown, failure);
    strictEqual(standaloneCalls, 0);
});
