import { strictEqual, ok } from 'node:assert';
import { BroadcastChannel, MessageChannel, MessagePort, Worker, parentPort, isMainThread, postMessageToThread, resourceLimits, threadId, workerData } from 'node:worker_threads';

const ADD_WASM = new Uint8Array([
    0x00, 0x61, 0x73, 0x6d,
    0x01, 0x00, 0x00, 0x00,
    0x01, 0x07, 0x01, 0x60, 0x02, 0x7f, 0x7f, 0x01, 0x7f,
    0x03, 0x02, 0x01, 0x00,
    0x07, 0x07, 0x01, 0x03, 0x61, 0x64, 0x64, 0x00, 0x00,
    0x0a, 0x09, 0x01, 0x07, 0x00, 0x20, 0x00, 0x20, 0x01, 0x6a, 0x0b,
]);

// worker_threads: the edge cases are (1) MessageChannel two-way round-trip,
// (2) postMessage between ports with onmessage, (3) isMainThread/threadId
// contract, (4) Worker + parentPort ping-pong, (5) workerData passthrough.

Deno.test({ name: 'worker_threads: isMainThread is true on main, threadId >= 0', timeout: 10000 }, () => {
    ok(isMainThread, 'must be main thread');
    ok(Number.isInteger(threadId) && threadId >= 0, 'threadId must be a non-negative integer');
});

Deno.test({ name: 'worker_threads: main-thread globals match Node defaults', timeout: 10000 }, () => {
    strictEqual(parentPort, null);
    strictEqual(workerData, null);
    strictEqual(Object.keys(resourceLimits).length, 0);
    strictEqual(BroadcastChannel, globalThis.BroadcastChannel);
});

Deno.test({ name: 'worker_threads: MessageChannel two-way round-trip', timeout: 10000 }, async () => {
    const { port1, port2 } = new MessageChannel();
    const got = await new Promise<any>((resolve, reject) => {
        port2.onmessage = (ev) => resolve(ev.data);
        port2.onerror = reject;
        port1.postMessage({ hello: 'world' });
    });
    strictEqual(got.hello, 'world');
    port1.close();
    port2.close();
});

Deno.test({ name: 'worker_threads: MessagePort echo (reply on same channel)', timeout: 10000 }, async () => {
    const { port1, port2 } = new MessageChannel();
    const reply = new Promise<any>((resolve) => {
        port2.onmessage = (ev) => {
            // echo back with a tag
            port2.postMessage({ ...ev.data, replied: true });
        };
        port1.onmessage = (ev) => resolve(ev.data);
        port1.postMessage({ ping: 1 });
    });
    const r = await reply;
    strictEqual(r.ping, 1);
    ok(r.replied, 'port2 must have tagged the reply');
    port1.close();
    port2.close();
});

Deno.test({ name: 'worker_threads: closed local MessagePort still validates and transfers', timeout: 10000 }, () => {
    const { port1, port2 } = new MessageChannel();
    port1.close();
    try {
        let threw = false;
        try {
            port1.postMessage(Symbol('not cloneable'));
        } catch (error) {
            threw = !!error && typeof error === 'object' && Reflect.get(error, 'name') === 'DataCloneError';
        }
        ok(threw, 'closed ports must still reject uncloneable payloads');

        const buffer = new ArrayBuffer(4);
        port1.postMessage({ buffer }, [buffer]);
        strictEqual(buffer.byteLength, 0, 'closed ports must still commit valid transfers');
    } finally {
        port1.close();
        port2.close();
    }
});

Deno.test({ name: 'worker_threads: postMessageToThread rejects clone errors asynchronously', timeout: 10000 }, async () => {
    const worker = new Worker('setInterval(() => {}, 1000);', { eval: true });
    try {
        let promise: Promise<void>;
        try {
            promise = postMessageToThread(worker.threadId, Symbol('not cloneable'));
        } catch (error) {
            throw new Error(`postMessageToThread threw synchronously: ${String(error)}`);
        }
        let rejected = false;
        try {
            await promise;
        } catch (error) {
            rejected = !!error && typeof error === 'object' && Reflect.get(error, 'name') === 'DataCloneError';
        }
        ok(rejected, 'clone errors must reject the returned promise');
    } finally {
        await worker.terminate();
    }
});

Deno.test({ name: 'worker_threads: Worker ping-pong via parentPort', timeout: 10000 }, async () => {
    const src = `
        const { parentPort } = require('node:worker_threads');
        parentPort.onmessage = (event) => {
            parentPort.postMessage({ echo: event.data });
        };
    `;
    const worker = new Worker(src, { eval: true });
    try {
        const reply: any = await new Promise((resolve, reject) => {
            worker.once('message', resolve);
            worker.once('error', reject);
            worker.postMessage('ping');
        });
        strictEqual(reply.echo, 'ping');
    } finally {
        await worker.terminate();
    }
});

Deno.test({ name: 'worker_threads: pre-ready postMessage queue does not drop bursts', timeout: 15000 }, async () => {
    const count = 1030;
    const src = `
        const { parentPort } = require('node:worker_threads');
        // Delay listener installation so the native pipe and the JS port both
        // have to retain the complete startup burst.
        parentPort.ref();
        setTimeout(() => {
            let seen = 0;
            let expected = 0;
            parentPort.on('message', (value) => {
                if (value !== expected) {
                    parentPort.postMessage({ error: 'message order mismatch' });
                    return;
                }
                seen++;
                expected++;
                if (seen === ${count}) parentPort.postMessage({ seen, first: 0, last: value });
            });
        }, 50);
    `;
    const worker = new Worker(src, { eval: true });
    try {
        const received = new Promise<{ seen: number; first: number; last: number }>((resolve, reject) => {
            worker.once('message', (value: { error?: string; seen?: number; first?: number; last?: number }) => {
                if (value.error) reject(new Error(value.error));
                else resolve(value as { seen: number; first: number; last: number });
            });
            worker.once('error', reject);
            worker.once('exit', (code: number) => reject(new Error(`worker exited before draining burst (${code})`)));
        });
        // Queue the whole burst synchronously, before the worker can report ready.
        // A bounded or silently dropping pre-ready queue loses messages past 1024.
        for (let i = 0; i < count; i++) worker.postMessage(i);
        const result = await received;
        strictEqual(result.seen, count);
        strictEqual(result.first, 0);
        strictEqual(result.last, count - 1);
    } finally {
        await worker.terminate();
    }
});

Deno.test({ name: 'worker_threads: Worker stdout and stderr streams exist when requested', timeout: 10000 }, async () => {
    const worker = new Worker('setInterval(() => {}, 1000);', {
        eval: true,
        stdout: true,
        stderr: true,
    });
    try {
        ok(worker.stdout, 'stdout must be a stream when requested');
        ok(worker.stderr, 'stderr must be a stream when requested');
        strictEqual(typeof worker.stdout.pipe, 'function');
        strictEqual(typeof worker.stdout.unpipe, 'function');
        strictEqual(typeof worker.stderr.pipe, 'function');
        strictEqual(typeof worker.stderr.unpipe, 'function');
    } finally {
        await worker.terminate();
    }
});

Deno.test({ name: 'worker_threads: Worker can import WebAssembly modules', timeout: 10000 }, async () => {
    const dir = Deno.makeTempDirSync({ prefix: 'cno-node-worker-wasm-' });
    const wasmFile = `${dir}/add.wasm`;
    const workerFile = `${dir}/worker.ts`;
    Deno.writeFileSync(wasmFile, ADD_WASM);
    Deno.writeTextFileSync(workerFile, `
        import { parentPort } from 'node:worker_threads';
        import wasm, { add } from './add.wasm';

        parentPort!.postMessage({
            named: add(30, 12),
            defaultExport: wasm.add(7, 8),
        });
    `);
    const worker = new Worker(workerFile);
    try {
        const reply: any = await new Promise((resolve, reject) => {
            worker.once('message', resolve);
            worker.once('error', reject);
        });
        strictEqual(reply.named, 42);
        strictEqual(reply.defaultExport, 15);
    } finally {
        await worker.terminate();
        Deno.removeSync(dir, { recursive: true });
    }
});

Deno.test({ name: 'worker_threads upstream: worker keeps independent dynamic import cache', timeout: 10000 }, async () => {
    const dir = Deno.makeTempDirSync({ prefix: 'cno-node-worker-cache-' });
    const modFile = `${dir}/mod.mjs`;
    const workerFile = `${dir}/worker.ts`;
    try {
        Deno.writeTextFileSync(modFile, 'export default true;\n');
        const mainImport = await import(`file://${modFile}`);
        strictEqual(mainImport.default, true);

        Deno.writeTextFileSync(workerFile, `
            import { parentPort } from 'node:worker_threads';
            import fs from 'node:fs/promises';
            await fs.writeFile(${JSON.stringify(modFile)}, 'export default false;\\n');
            const mod = await import(${JSON.stringify(`file://${modFile}`)});
            parentPort!.postMessage(mod.default);
        `);

        const worker = new Worker(workerFile);
        try {
            const value = await new Promise<boolean>((resolve, reject) => {
                worker.once('message', resolve);
                worker.once('error', reject);
                // Without an 'exit' handler a worker that dies before posting can only end
                // as the outer harness timeout, which reports nothing about the cause.
                worker.once('exit', (code: number) =>
                    reject(new Error(`worker exited (code=${code}) before posting a message`)));
            });
            strictEqual(value, false);
        } finally {
            await worker.terminate();
        }
    } finally {
        Deno.removeSync(dir, { recursive: true });
    }
});

Deno.test({ name: 'worker_threads: Worker WebAssembly API is available inside eval worker', timeout: 10000 }, async () => {
    const src = `
        const { parentPort } = require('node:worker_threads');
        const bytes = new Uint8Array([${Array.from(ADD_WASM).join(',')}]);
        WebAssembly.instantiate(bytes).then(({ instance }) => {
            parentPort.postMessage({
                instantiate: typeof WebAssembly.instantiate,
                value: instance.exports.add(14, 15),
            });
        }, (error) => {
            parentPort.postMessage({ error: String(error && error.message || error) });
        });
    `;
    const worker = new Worker(src, { eval: true });
    try {
        const reply: any = await new Promise((resolve, reject) => {
            worker.once('message', resolve);
            worker.once('error', reject);
        });
        strictEqual(reply.error, undefined);
        strictEqual(reply.instantiate, 'function');
        strictEqual(reply.value, 29);
    } finally {
        await worker.terminate();
    }
});

Deno.test({ name: 'worker_threads: workerData is delivered to the worker', timeout: 10000 }, async () => {
    const src = `
        const { parentPort, workerData } = require('node:worker_threads');
        parentPort.postMessage(workerData);
    `;
    const worker = new Worker(src, { eval: true, workerData: { foo: 42 } });
    try {
        const msg: any = await new Promise((resolve, reject) => {
            worker.once('message', resolve);
            worker.once('error', reject);
        });
        strictEqual(msg.foo, 42);
    } finally {
        await worker.terminate();
    }
});

Deno.test({ name: 'worker_threads: Worker threadId differs from main', timeout: 10000 }, async () => {
    const src = `
        const { parentPort, threadId, isMainThread } = require('node:worker_threads');
        parentPort.postMessage({ threadId, isMainThread });
    `;
    const worker = new Worker(src, { eval: true });
    try {
        const msg: any = await new Promise((resolve, reject) => {
            worker.once('message', resolve);
            worker.once('error', reject);
        });
        ok(!msg.isMainThread, 'inside worker, isMainThread must be false');
        ok(msg.threadId !== threadId, 'worker threadId must differ from main');
    } finally {
        await worker.terminate();
    }
});

Deno.test({ name: 'worker_threads: parentPort is null on main thread', timeout: 10000 }, () => {
    strictEqual(parentPort, null, 'main thread parentPort must be null');
});

// Real Node v24.18.0 resolves terminate() with 1 for a live worker, and undefined for
// an already-exited worker or a second call — never 0. Verified on win32:
//   alive.terminate() -> 1 | second terminate() -> undefined | exited.terminate() -> undefined
Deno.test({ name: 'worker_threads: Worker terminate resolves with exit code 1 for a live worker', timeout: 10000 }, async () => {
    const worker = new Worker('setInterval(() => {}, 1000);', { eval: true });
    strictEqual(await worker.terminate(), 1);
});

Deno.test({ name: 'worker_threads: Worker postMessage transfer detaches source ArrayBuffer', timeout: 10000 }, async () => {
    const src = `
        const { parentPort } = require('node:worker_threads');
        parentPort.on('message', (value) => {
            parentPort.postMessage({
                isUint8Array: value instanceof Uint8Array,
                length: value.length,
                third: value[2],
            });
        });
    `;
    const buffer = new ArrayBuffer(4);
    new Uint8Array(buffer).set([1, 2, 3, 4]);
    const worker = new Worker(src, { eval: true });
    try {
        const reply: any = await new Promise((resolve, reject) => {
            worker.once('message', resolve);
            worker.once('error', reject);
            worker.postMessage(new Uint8Array(buffer), [buffer]);
        });
        ok(reply.isUint8Array);
        strictEqual(reply.length, 4);
        strictEqual(reply.third, 3);
        strictEqual(buffer.byteLength, 0);
    } finally {
        await worker.terminate();
    }
});

Deno.test({ name: 'worker_threads: large ArrayBuffer transfer detaches synchronously and round-trips bytes', timeout: 15000 }, async () => {
    const src = `
        const { parentPort } = require('node:worker_threads');
        parentPort.on('message', ({ buffer }) => {
            const bytes = new Uint8Array(buffer);
            const length = bytes.length;
            const first = bytes[0];
            const middle = bytes[length >>> 1];
            const last = bytes[length - 1];
            parentPort.postMessage({ buffer, length, first, middle, last }, [buffer]);
            parentPort.postMessage({ workerDetached: buffer.byteLength });
        });
    `;
    const size = 8 * 1024 * 1024;
    const buffer = new ArrayBuffer(size);
    const bytes = new Uint8Array(buffer);
    bytes[0] = 17;
    bytes[size >>> 1] = 93;
    bytes[size - 1] = 241;
    const worker = new Worker(src, { eval: true });
    try {
        const messages = new Promise<any[]>((resolve, reject) => {
            const out: any[] = [];
            worker.on('message', (value) => {
                out.push(value);
                if (out.length === 2) resolve(out);
            });
            worker.once('error', reject);
        });
        worker.postMessage({ buffer }, [buffer]);
        strictEqual(buffer.byteLength, 0, 'the sender must detach before postMessage returns');

        const [received, detached] = await messages;
        ok(received.buffer instanceof ArrayBuffer);
        strictEqual(received.buffer.byteLength, size);
        strictEqual(received.length, size);
        strictEqual(received.first, 17);
        strictEqual(received.middle, 93);
        strictEqual(received.last, 241);
        strictEqual(detached.workerDetached, 0, 'the worker must detach before its postMessage returns');
    } finally {
        await worker.terminate();
    }
});

Deno.test({ name: 'worker_threads: transfer preserves shared view backing across multiple ArrayBuffers', timeout: 10000 }, async () => {
    const src = `
        const { parentPort } = require('node:worker_threads');
        parentPort.on('message', ({ first, overlap, direct, second }) => {
            parentPort.postMessage({
                firstSharesOverlap: first.buffer === overlap.buffer,
                firstSharesDirect: first.buffer === direct,
                buffersDiffer: first.buffer !== second.buffer,
                firstOffset: first.byteOffset,
                overlapOffset: overlap.byteOffset,
                secondOffset: second.byteOffset,
                overlapValue: overlap[1],
                secondValue: second[2],
            });
        });
    `;
    const firstBuffer = new ArrayBuffer(32);
    const secondBuffer = new ArrayBuffer(24);
    const first = new Uint8Array(firstBuffer, 2, 12);
    const overlap = new Uint8Array(firstBuffer, 6, 8);
    const second = new Uint16Array(secondBuffer, 4, 4);
    overlap[1] = 123;
    second[2] = 0x4567;
    const worker = new Worker(src, { eval: true });
    try {
        const reply: any = await new Promise((resolve, reject) => {
            worker.once('message', resolve);
            worker.once('error', reject);
            worker.postMessage({ first, overlap, direct: firstBuffer, second }, [firstBuffer, secondBuffer]);
            strictEqual(firstBuffer.byteLength, 0);
            strictEqual(secondBuffer.byteLength, 0);
        });
        ok(reply.firstSharesOverlap);
        ok(reply.firstSharesDirect);
        ok(reply.buffersDiffer);
        strictEqual(reply.firstOffset, 2);
        strictEqual(reply.overlapOffset, 6);
        strictEqual(reply.secondOffset, 4);
        strictEqual(reply.overlapValue, 123);
        strictEqual(reply.secondValue, 0x4567);
    } finally {
        await worker.terminate();
    }
});

Deno.test({ name: 'worker_threads: Worker postMessage duplicate transfer throws before detach', timeout: 10000 }, async () => {
    const src = `
        const { parentPort } = require('node:worker_threads');
        parentPort.on('message', () => {});
    `;
    const worker = new Worker(src, { eval: true });
    try {
        const buffer = new ArrayBuffer(4);
        let threw = false;
        try { worker.postMessage({ buffer }, [buffer, buffer]); } catch { threw = true; }
        ok(threw, 'duplicate transfer list entries must throw');
        strictEqual(buffer.byteLength, 4);
    } finally {
        await worker.terminate();
    }
});

Deno.test({ name: 'worker_threads: invalid transfer list is atomic and leaves the pipe usable', timeout: 10000 }, async () => {
    const src = `
        const { parentPort } = require('node:worker_threads');
        parentPort.on('message', (value) => parentPort.postMessage(value));
    `;
    const worker = new Worker(src, { eval: true });
    try {
        const buffer = new ArrayBuffer(8);
        new Uint8Array(buffer)[3] = 77;
        let errorName: unknown;
        try {
            worker.postMessage({ buffer }, [buffer, {}]);
        } catch (error) {
            errorName = error && typeof error === 'object' ? Reflect.get(error, 'name') : undefined;
        }
        strictEqual(errorName, 'DataCloneError');
        strictEqual(buffer.byteLength, 8, 'validation failure must not detach an earlier transfer entry');
        strictEqual(new Uint8Array(buffer)[3], 77);

        const reply: any = await new Promise((resolve, reject) => {
            worker.once('message', resolve);
            worker.once('error', reject);
            worker.postMessage({ tag: 'after-invalid-transfer' });
        });
        strictEqual(reply.tag, 'after-invalid-transfer');
    } finally {
        await worker.terminate();
    }
});

Deno.test({ name: 'worker_threads: serialization failure does not detach transfers or poison the pipe', timeout: 10000 }, async () => {
    const src = `
        const { parentPort } = require('node:worker_threads');
        parentPort.on('message', (value) => parentPort.postMessage(value));
    `;
    const worker = new Worker(src, { eval: true });
    try {
        const buffer = new ArrayBuffer(8);
        new Uint8Array(buffer)[5] = 109;
        let errorName: unknown;
        try {
            // The serializer sees the transferable before reaching the function.
            // A later failure must roll the whole operation back without detaching it.
            worker.postMessage({ buffer, notCloneable() {} }, [buffer]);
        } catch (error) {
            errorName = error && typeof error === 'object' ? Reflect.get(error, 'name') : undefined;
        }
        strictEqual(errorName, 'DataCloneError');
        strictEqual(buffer.byteLength, 8);
        strictEqual(new Uint8Array(buffer)[5], 109);

        const reply: any = await new Promise((resolve, reject) => {
            worker.once('message', resolve);
            worker.once('error', reject);
            worker.postMessage({ tag: 'after-serialization-error' });
        });
        strictEqual(reply.tag, 'after-serialization-error');
    } finally {
        await worker.terminate();
    }
});

Deno.test({ name: 'worker_threads: Worker postMessage transfer-only ArrayBuffer detaches without payload reference', timeout: 10000 }, async () => {
    const src = `
        const { parentPort } = require('node:worker_threads');
        parentPort.on('message', (value) => {
            parentPort.postMessage({
                tag: value.tag,
                hasBuffer: 'buffer' in value,
            });
        });
    `;
    const buffer = new ArrayBuffer(4);
    new Uint8Array(buffer).set([1, 2, 3, 4]);
    const worker = new Worker(src, { eval: true });
    try {
        const reply: any = await new Promise((resolve, reject) => {
            worker.once('message', resolve);
            worker.once('error', reject);
            worker.postMessage({ tag: 'buffer-only' }, [buffer]);
        });
        strictEqual(buffer.byteLength, 0);
        strictEqual(reply.tag, 'buffer-only');
        strictEqual(reply.hasBuffer, false);
    } finally {
        await worker.terminate();
    }
});

Deno.test({ name: 'worker_threads: Worker postMessage from online waits for parentPort readiness', timeout: 10000 }, async () => {
    const src = `
        const { parentPort } = require('node:worker_threads');
        parentPort.on('message', (value) => {
            parentPort.postMessage({
                tag: value.tag,
                hasBuffer: 'buffer' in value,
            });
        });
    `;
    const buffer = new ArrayBuffer(4);
    new Uint8Array(buffer).set([1, 2, 3, 4]);
    const worker = new Worker(src, { eval: true });
    try {
        const reply: any = await new Promise((resolve, reject) => {
            worker.once('message', resolve);
            worker.once('error', reject);
            worker.once('online', () => {
                worker.postMessage({ tag: 'online-buffer-only' }, [buffer]);
            });
        });
        strictEqual(buffer.byteLength, 0);
        strictEqual(reply.tag, 'online-buffer-only');
        strictEqual(reply.hasBuffer, false);
    } finally {
        await worker.terminate();
    }
});

Deno.test({ name: 'worker_threads: Worker postMessage preserves shared backing buffer without transfer', timeout: 10000 }, async () => {
    const src = `
        const { parentPort } = require('node:worker_threads');
        parentPort.on('message', (value) => {
            parentPort.postMessage({
                sameBuffer: value.a.buffer === value.b.buffer,
                aOffset: value.a.byteOffset,
                bOffset: value.b.byteOffset,
                bFourth: value.b[3],
            });
        });
    `;
    const buffer = new ArrayBuffer(8);
    const a = new Uint8Array(buffer, 0, 4);
    const b = new Uint8Array(buffer, 2, 4);
    a.set([1, 2, 3, 4]);
    b.set([5, 6], 2);
    const worker = new Worker(src, { eval: true });
    try {
        const reply: any = await new Promise((resolve, reject) => {
            worker.once('message', resolve);
            worker.once('error', reject);
            worker.postMessage({ a, b });
        });
        ok(reply.sameBuffer);
        strictEqual(reply.aOffset, 0);
        strictEqual(reply.bOffset, 2);
        strictEqual(reply.bFourth, 6);
        strictEqual(buffer.byteLength, 8);
    } finally {
        await worker.terminate();
    }
});

Deno.test({ name: 'worker_threads: Worker postMessage clones structured data types', timeout: 10000 }, async () => {
    const src = `
        const { parentPort } = require('node:worker_threads');
        parentPort.on('message', (data) => {
            const mapKey = Array.from(data.map.keys())[0];
            parentPort.postMessage({
                isDate: data.date instanceof Date,
                dateTime: data.date.getTime(),
                isRegExp: data.regex instanceof RegExp,
                regexSource: data.regex.source,
                regexFlags: data.regex.flags,
                regexLastIndex: data.regex.lastIndex,
                isTypeError: data.error instanceof TypeError,
                errorName: data.error.name,
                errorMessage: data.error.message,
                errorHasCode: 'code' in data.error,
                errorCause: data.error.cause.reason,
                instanceProtoIsObject: Object.getPrototypeOf(data.instance) === Object.prototype,
                instanceValue: data.instance.value,
                symbolCount: Object.getOwnPropertySymbols(data.instance).length,
                circular: data.circular.self === data.circular,
                mapKeyMatchesRef: mapKey === data.ref,
                setHasRef: data.set.has(data.ref),
            });
        });
    `;
    class Box {
        value = 33;
        read() { return this.value; }
    }
    const symbol = Symbol('hidden');
    const instance = new Box() as Box & { [symbol]?: number };
    instance[symbol] = 44;
    const circular: { name: string; self?: unknown } = { name: 'root' };
    circular.self = circular;
    const ref = { id: 1 };
    const regex = /node-worker/gy;
    regex.lastIndex = 3;
    const error = new TypeError('bad main payload') as TypeError & { code?: string; cause?: unknown };
    error.code = 'DROP_ME';
    error.cause = { reason: 'nested' };
    const worker = new Worker(src, { eval: true });
    try {
        const reply: any = await new Promise((resolve, reject) => {
            worker.once('message', resolve);
            worker.once('error', reject);
            worker.postMessage({
                date: new Date(123456),
                regex,
                error,
                instance,
                circular,
                ref,
                map: new Map([[ref, 'value']]),
                set: new Set([ref]),
            });
        });
        ok(reply.isDate);
        strictEqual(reply.dateTime, 123456);
        ok(reply.isRegExp);
        strictEqual(reply.regexSource, 'node-worker');
        strictEqual(reply.regexFlags, 'gy');
        strictEqual(reply.regexLastIndex, 0);
        ok(reply.isTypeError);
        strictEqual(reply.errorName, 'TypeError');
        strictEqual(reply.errorMessage, 'bad main payload');
        strictEqual(reply.errorHasCode, false);
        strictEqual(reply.errorCause, 'nested');
        ok(reply.instanceProtoIsObject);
        strictEqual(reply.instanceValue, 33);
        strictEqual(reply.symbolCount, 0);
        ok(reply.circular);
        ok(reply.mapKeyMatchesRef);
        ok(reply.setHasRef);
    } finally {
        await worker.terminate();
    }
});

Deno.test({ name: 'worker_threads: parentPort postMessage transfer detaches worker ArrayBuffer', timeout: 10000 }, async () => {
    const src = `
        const { parentPort } = require('node:worker_threads');
        const buffer = new ArrayBuffer(8);
        const view = new Uint8Array(buffer, 2, 3);
        view.set([21, 22, 23]);
        parentPort.postMessage({ view }, [buffer]);
        parentPort.postMessage({ afterDetach: buffer.byteLength });
    `;
    const worker = new Worker(src, { eval: true });
    try {
        const messages: any[] = await new Promise((resolve, reject) => {
            const out: any[] = [];
            worker.on('message', (value) => {
                out.push(value);
                if (out.length === 2) resolve(out);
            });
            worker.once('error', reject);
        });
        const received = messages[0].view;
        ok(received instanceof Uint8Array);
        strictEqual(received.byteOffset, 2);
        strictEqual(received.length, 3);
        strictEqual(received[1], 22);
        strictEqual(received.buffer.byteLength, 8);
        strictEqual(messages[1].afterDetach, 0);
    } finally {
        await worker.terminate();
    }
});

Deno.test({ name: 'worker_threads: parentPort transfer failure is atomic inside the worker', timeout: 10000 }, async () => {
    const src = `
        const { parentPort } = require('node:worker_threads');
        const buffer = new ArrayBuffer(8);
        new Uint8Array(buffer)[4] = 61;
        let errorName;
        try {
            parentPort.postMessage({ buffer, notCloneable() {} }, [buffer]);
        } catch (error) {
            errorName = error && error.name;
        }
        parentPort.postMessage({
            errorName,
            byteLength: buffer.byteLength,
            preserved: new Uint8Array(buffer)[4],
        });
    `;
    const worker = new Worker(src, { eval: true });
    try {
        const result: any = await new Promise((resolve, reject) => {
            worker.once('message', resolve);
            worker.once('error', reject);
        });
        strictEqual(result.errorName, 'DataCloneError');
        strictEqual(result.byteLength, 8);
        strictEqual(result.preserved, 61);
    } finally {
        await worker.terminate();
    }
});

Deno.test({ name: 'worker_threads: parentPort postMessage transfer-only ArrayBuffer detaches without payload reference', timeout: 10000 }, async () => {
    const src = `
        const { parentPort } = require('node:worker_threads');
        const buffer = new ArrayBuffer(4);
        new Uint8Array(buffer).set([1, 2, 3, 4]);
        parentPort.postMessage({ tag: 'buffer-only' }, [buffer]);
        parentPort.postMessage({ afterDetach: buffer.byteLength });
    `;
    const worker = new Worker(src, { eval: true });
    try {
        const messages: any[] = await new Promise((resolve, reject) => {
            const out: any[] = [];
            worker.on('message', (value) => {
                out.push(value);
                if (out.length === 2) resolve(out);
            });
            worker.once('error', reject);
        });
        strictEqual(messages[0].tag, 'buffer-only');
        strictEqual('buffer' in messages[0], false);
        strictEqual(messages[1].afterDetach, 0);
    } finally {
        await worker.terminate();
    }
});

Deno.test({ name: 'worker_threads: parentPort postMessage preserves shared backing buffer without transfer', timeout: 10000 }, async () => {
    const src = `
        const { parentPort } = require('node:worker_threads');
        const buffer = new ArrayBuffer(8);
        const a = new Uint8Array(buffer, 0, 4);
        const b = new Uint8Array(buffer, 2, 4);
        a.set([1, 2, 3, 4]);
        b.set([5, 6], 2);
        parentPort.postMessage({ a, b });
    `;
    const worker = new Worker(src, { eval: true });
    try {
        const received: any = await new Promise((resolve, reject) => {
            worker.once('message', resolve);
            worker.once('error', reject);
        });
        ok(received.a instanceof Uint8Array);
        ok(received.b instanceof Uint8Array);
        strictEqual(received.a.buffer, received.b.buffer);
        strictEqual(received.a.byteOffset, 0);
        strictEqual(received.b.byteOffset, 2);
        strictEqual(received.b[3], 6);
    } finally {
        await worker.terminate();
    }
});

Deno.test({ name: 'worker_threads: parentPort postMessage clones structured data types', timeout: 10000 }, async () => {
    const src = `
        const { parentPort } = require('node:worker_threads');
        class Box {
            constructor() { this.value = 74; }
            read() { return this.value; }
        }
        const symbol = Symbol('hidden');
        const instance = new Box();
        instance[symbol] = 88;
        const circular = { name: 'worker' };
        circular.self = circular;
        const ref = { id: 2 };
        const regex = /from-parent-port/gi;
        regex.lastIndex = 4;
        const error = new RangeError('bad worker payload');
        error.code = 'DROP_ME';
        error.cause = { reason: 'worker-nested' };
        parentPort.postMessage({
            date: new Date(654321),
            regex,
            error,
            instance,
            circular,
            ref,
            map: new Map([[ref, 'value']]),
            set: new Set([ref]),
        });
    `;
    const worker = new Worker(src, { eval: true });
    try {
        const data: any = await new Promise((resolve, reject) => {
            worker.once('message', resolve);
            worker.once('error', reject);
        });
        ok(data.date instanceof Date);
        strictEqual(data.date.getTime(), 654321);
        ok(data.regex instanceof RegExp);
        strictEqual(data.regex.source, 'from-parent-port');
        strictEqual(data.regex.flags, 'gi');
        strictEqual(data.regex.lastIndex, 0);
        ok(data.error instanceof RangeError);
        strictEqual(data.error.name, 'RangeError');
        strictEqual(data.error.message, 'bad worker payload');
        strictEqual('code' in data.error, false);
        strictEqual(data.error.cause.reason, 'worker-nested');
        strictEqual(Object.getPrototypeOf(data.instance), Object.prototype);
        strictEqual(data.instance.value, 74);
        strictEqual(Object.getOwnPropertySymbols(data.instance).length, 0);
        strictEqual(data.circular.self, data.circular);
        const [mapKey] = data.map.keys();
        strictEqual(mapKey, data.ref);
        ok(data.set.has(data.ref));
    } finally {
        await worker.terminate();
    }
});

Deno.test({ name: 'worker_threads: setEnvironmentData is visible to new workers', timeout: 10000 }, async () => {
    const wt = require('node:worker_threads') as {
        getEnvironmentData: (key: unknown) => unknown;
        setEnvironmentData: (key: unknown, value?: unknown) => void;
        Worker: typeof Worker;
    };
    wt.setEnvironmentData('cno-env-key', { a: 1 });
    strictEqual((wt.getEnvironmentData('cno-env-key') as { a: number }).a, 1);

    const src = `
        const { parentPort, getEnvironmentData } = require('node:worker_threads');
        parentPort.postMessage(getEnvironmentData('cno-env-key'));
    `;
    const worker = new wt.Worker(src, { eval: true });
    try {
        const msg: any = await new Promise((resolve, reject) => {
            worker.once('message', resolve);
            worker.once('error', reject);
        });
        strictEqual(msg.a, 1);
    } finally {
        wt.setEnvironmentData('cno-env-key', undefined);
        await worker.terminate();
    }
});

Deno.test({ name: 'worker_threads: workerData clones structured data types', timeout: 10000 }, async () => {
    const src = `
        const { parentPort, workerData } = require('node:worker_threads');
        const data = workerData;
        const mapKey = Array.from(data.map.keys())[0];
        parentPort.postMessage({
            isDate: data.date instanceof Date,
            dateTime: data.date.getTime(),
            isRegExp: data.regex instanceof RegExp,
            regexSource: data.regex.source,
            regexFlags: data.regex.flags,
            regexLastIndex: data.regex.lastIndex,
            isTypeError: data.error instanceof TypeError,
            errorName: data.error.name,
            errorMessage: data.error.message,
            errorHasCode: 'code' in data.error,
            errorCause: data.error.cause.reason,
            instanceProtoIsObject: Object.getPrototypeOf(data.instance) === Object.prototype,
            instanceValue: data.instance.value,
            symbolCount: Object.getOwnPropertySymbols(data.instance).length,
            circular: data.circular.self === data.circular,
            mapKeyMatchesRef: mapKey === data.ref,
            setHasRef: data.set.has(data.ref),
        });
    `;
    class Box {
        value = 55;
        read() { return this.value; }
    }
    const symbol = Symbol('hidden');
    const instance = new Box() as Box & { [symbol]?: number };
    instance[symbol] = 66;
    const circular: { name: string; self?: unknown } = { name: 'workerData' };
    circular.self = circular;
    const ref = { id: 3 };
    const regex = /worker-data/gy;
    regex.lastIndex = 5;
    const error = new TypeError('bad workerData') as TypeError & { code?: string; cause?: unknown };
    error.code = 'DROP_ME';
    error.cause = { reason: 'workerData-nested' };
    const worker = new Worker(src, {
        eval: true,
        workerData: {
            date: new Date(777888),
            regex,
            error,
            instance,
            circular,
            ref,
            map: new Map([[ref, 'value']]),
            set: new Set([ref]),
        },
    });
    try {
        const reply: any = await new Promise((resolve, reject) => {
            worker.once('message', resolve);
            worker.once('error', reject);
        });
        ok(reply.isDate);
        strictEqual(reply.dateTime, 777888);
        ok(reply.isRegExp);
        strictEqual(reply.regexSource, 'worker-data');
        strictEqual(reply.regexFlags, 'gy');
        strictEqual(reply.regexLastIndex, 0);
        ok(reply.isTypeError);
        strictEqual(reply.errorName, 'TypeError');
        strictEqual(reply.errorMessage, 'bad workerData');
        strictEqual(reply.errorHasCode, false);
        strictEqual(reply.errorCause, 'workerData-nested');
        ok(reply.instanceProtoIsObject);
        strictEqual(reply.instanceValue, 55);
        strictEqual(reply.symbolCount, 0);
        ok(reply.circular);
        ok(reply.mapKeyMatchesRef);
        ok(reply.setHasRef);
    } finally {
        await worker.terminate();
    }
});

Deno.test({ name: 'worker_threads: workerData transferList detaches source ArrayBuffer', timeout: 10000 }, async () => {
    const src = `
        const { parentPort, workerData } = require('node:worker_threads');
        const view = workerData.view;
        parentPort.postMessage({
            isUint8Array: view instanceof Uint8Array,
            byteOffset: view.byteOffset,
            length: view.length,
            second: view[1],
            bufferLength: view.buffer.byteLength,
        });
    `;
    const buffer = new ArrayBuffer(8);
    const view = new Uint8Array(buffer, 2, 3);
    view.set([91, 92, 93]);
    const worker = new Worker(src, {
        eval: true,
        workerData: { view },
        transferList: [buffer],
    });
    try {
        const msg: any = await new Promise((resolve, reject) => {
            worker.once('message', resolve);
            worker.once('error', reject);
        });
        ok(msg.isUint8Array);
        strictEqual(msg.byteOffset, 2);
        strictEqual(msg.length, 3);
        strictEqual(msg.second, 92);
        strictEqual(msg.bufferLength, 8);
        strictEqual(buffer.byteLength, 0);
    } finally {
        await worker.terminate();
    }
});

Deno.test({ name: 'worker_threads: large workerData transfer preserves bytes and detaches synchronously', timeout: 15000 }, async () => {
    const src = `
        const { parentPort, workerData } = require('node:worker_threads');
        const bytes = new Uint8Array(workerData.buffer);
        parentPort.postMessage({
            length: bytes.length,
            first: bytes[0],
            middle: bytes[bytes.length >>> 1],
            last: bytes[bytes.length - 1],
        });
    `;
    const size = 8 * 1024 * 1024;
    const buffer = new ArrayBuffer(size);
    const bytes = new Uint8Array(buffer);
    bytes[0] = 19;
    bytes[size >>> 1] = 101;
    bytes[size - 1] = 227;
    const worker = new Worker(src, {
        eval: true,
        workerData: { buffer },
        transferList: [buffer],
    });
    try {
        strictEqual(buffer.byteLength, 0, 'workerData transfer must detach before construction returns');
        const msg: any = await new Promise((resolve, reject) => {
            worker.once('message', resolve);
            worker.once('error', reject);
        });
        strictEqual(msg.length, size);
        strictEqual(msg.first, 19);
        strictEqual(msg.middle, 101);
        strictEqual(msg.last, 227);
    } finally {
        await worker.terminate();
    }
});

Deno.test({ name: 'worker_threads: failed workerData serialization leaves transfer attached', timeout: 10000 }, () => {
    const buffer = new ArrayBuffer(8);
    new Uint8Array(buffer)[2] = 47;
    let errorName: unknown;
    try {
        new Worker('setInterval(() => {}, 1000);', {
            eval: true,
            workerData: { buffer, notCloneable() {} },
            transferList: [buffer],
        });
    } catch (error) {
        errorName = error && typeof error === 'object' ? Reflect.get(error, 'name') : undefined;
    }
    strictEqual(errorName, 'DataCloneError');
    strictEqual(buffer.byteLength, 8);
    strictEqual(new Uint8Array(buffer)[2], 47);
});

Deno.test({
    name: 'worker_threads: native transfer throughput diagnostic',
    ignore: Deno.env.get('CNO_WORKER_TRANSFER_DIAGNOSTIC') !== '1',
    timeout: 60000,
}, async () => {
    const src = `
        const { parentPort } = require('node:worker_threads');
        parentPort.on('message', (buffer) => parentPort.postMessage(buffer, [buffer]));
    `;
    const rounds = 16;
    const size = 16 * 1024 * 1024;
    const worker = new Worker(src, { eval: true });
    try {
        let buffer = new ArrayBuffer(size);
        new Uint8Array(buffer)[size - 1] = 211;
        const started = performance.now();
        for (let round = 0; round < rounds; round++) {
            buffer = await new Promise<ArrayBuffer>((resolve, reject) => {
                worker.once('message', resolve);
                worker.once('error', reject);
                worker.postMessage(buffer, [buffer]);
            });
            strictEqual(buffer.byteLength, size);
        }
        const elapsedMs = performance.now() - started;
        strictEqual(new Uint8Array(buffer)[size - 1], 211);
        const movedMiB = (rounds * size * 2) / (1024 * 1024);
        console.log(`worker transfer diagnostic: ${movedMiB} MiB in ${elapsedMs.toFixed(1)} ms (${(movedMiB * 1000 / elapsedMs).toFixed(1)} MiB/s)`);
    } finally {
        await worker.terminate();
    }
});

Deno.test({ name: 'worker_threads: workerData duplicate transferList throws before detach', timeout: 10000 }, () => {
    const buffer = new ArrayBuffer(4);
    let threw = false;
    try {
        new Worker('setInterval(() => {}, 1000);', {
            eval: true,
            workerData: { buffer },
            transferList: [buffer, buffer],
        });
    } catch {
        threw = true;
    }
    ok(threw, 'duplicate workerData transferList entries must throw');
    strictEqual(buffer.byteLength, 4);
});

Deno.test({ name: 'worker_threads: Worker exposes threadName and resourceLimits', timeout: 10000 }, async () => {
    const wt = require('node:worker_threads') as {
        Worker: typeof Worker;
    };
    const src = `
        const { parentPort, threadName, resourceLimits } = require('node:worker_threads');
        parentPort.postMessage({ threadName, resourceLimits });
    `;
    const worker = new wt.Worker(src, {
        eval: true,
        name: 'named-worker',
        resourceLimits: { maxOldGenerationSizeMb: 8 },
    } as unknown as ConstructorParameters<typeof Worker>[1]);
    try {
        strictEqual((worker as typeof worker & { threadName?: unknown }).threadName, 'named-worker');
        const msg: any = await new Promise((resolve, reject) => {
            worker.once('message', resolve);
            worker.once('error', reject);
        });
        strictEqual(msg.threadName, 'named-worker');
        strictEqual(msg.resourceLimits.maxOldGenerationSizeMb, 8);
    } finally {
        await worker.terminate();
    }
});

Deno.test({ name: 'worker_threads: structuredClone deep-clones plain objects', timeout: 10000 }, () => {
    const wt = require('node:worker_threads') as {
        structuredClone: <T>(value: T) => T;
    };
    const input = { nested: { value: 1 }, list: [1, 2, 3] };
    const output = wt.structuredClone(input);
    strictEqual(output.nested.value, 1);
    output.nested.value = 9;
    strictEqual(input.nested.value, 1);
});

Deno.test({ name: 'worker_threads: structuredClone transfer detaches ArrayBuffer', timeout: 10000 }, () => {
    const wt = require('node:worker_threads') as {
        structuredClone: <T>(value: T, options?: StructuredSerializeOptions) => T;
    };
    const buffer = new ArrayBuffer(8);
    const view = new Uint8Array(buffer, 2, 3);
    view.set([71, 72, 73]);
    const output = wt.structuredClone({ view }, { transfer: [buffer] });
    ok(output.view instanceof Uint8Array);
    strictEqual(output.view.byteOffset, 2);
    strictEqual(output.view.length, 3);
    strictEqual(output.view[1], 72);
    strictEqual(output.view.buffer.byteLength, 8);
    strictEqual(buffer.byteLength, 0);
});

Deno.test({ name: 'worker_threads: markAsUntransferable flags objects for introspection', timeout: 10000 }, () => {
    const wt = require('node:worker_threads') as {
        markAsUntransferable: (value: object) => void;
        isMarkedAsUntransferable: (value: object) => boolean;
    };
    const obj = {};
    strictEqual(wt.isMarkedAsUntransferable(obj), false);
    strictEqual(wt.markAsUntransferable(obj), undefined);
    strictEqual(wt.isMarkedAsUntransferable(obj), true);
});

Deno.test({ name: 'worker_threads: markAsUncloneable rejects postMessage payloads', timeout: 10000 }, () => {
    const wt = require('node:worker_threads') as {
        MessageChannel: typeof MessageChannel;
        markAsUncloneable: (value: object) => void;
    };
    const { port1, port2 } = new wt.MessageChannel();
    try {
        const value = { blocked: true };
        wt.markAsUncloneable(value);
        let threw = false;
        try { port1.postMessage(value); } catch { threw = true; }
        ok(threw, 'marked object must not be cloned');
    } finally {
        port1.close();
        port2.close();
    }
});

Deno.test({ name: 'worker_threads: markAsUntransferable rejects transfer without detaching', timeout: 10000 }, () => {
    const wt = require('node:worker_threads') as {
        MessageChannel: typeof MessageChannel;
        markAsUntransferable: (value: object) => void;
    };
    const { port1, port2 } = new wt.MessageChannel();
    try {
        const buffer = new ArrayBuffer(4);
        wt.markAsUntransferable(buffer);
        let threw = false;
        try { port1.postMessage({ buffer }, [buffer]); } catch { threw = true; }
        ok(threw, 'marked object must not be transferred');
        strictEqual(buffer.byteLength, 4);
    } finally {
        port1.close();
        port2.close();
    }
});

Deno.test({ name: 'worker_threads: moveMessagePortToContext returns a working MessagePort', timeout: 10000 }, async () => {
    const wt = require('node:worker_threads') as {
        moveMessagePortToContext: (port: MessagePort, context: object) => MessagePort;
    };
    const { port1, port2 } = new MessageChannel();
    try {
        const moved = wt.moveMessagePortToContext(port1, {});
        strictEqual(moved, port1);
        const got = new Promise<string>((resolve) => {
            moved.on('message', (value) => resolve(value as string));
        });
        port2.postMessage('hello');
        strictEqual(await got, 'hello');
    } finally {
        port1.close();
        port2.close();
    }
});

Deno.test({ name: 'worker_threads: process.exit in worker is not catchable', timeout: 10000 }, async () => {
    const src = `
        const { parentPort } = require('node:worker_threads');
        try {
            process.exit(0);
        } catch (e) {
            parentPort.postMessage({ caught: String(e && e.message || e) });
        }
        parentPort.postMessage({ afterExit: true });
    `;
    const worker = new Worker(src, { eval: true });
    try {
        const message = await Promise.race([
            new Promise((resolve, reject) => {
                worker.once('message', resolve);
                worker.once('error', reject);
            }),
            new Promise((resolve) => setTimeout(() => resolve(undefined), 150)),
        ]);
        strictEqual(message, undefined);
    } finally {
        await worker.terminate();
    }
});
