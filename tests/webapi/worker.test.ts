import { ok, strictEqual } from 'node:assert';
import { writeFileSync, unlinkSync } from 'node:fs';

const decodeUtf8 = (bytes: Uint8Array): string => new TextDecoder().decode(bytes);

const ADD_WASM = new Uint8Array([
    0x00, 0x61, 0x73, 0x6d,
    0x01, 0x00, 0x00, 0x00,
    0x01, 0x07, 0x01, 0x60, 0x02, 0x7f, 0x7f, 0x01, 0x7f,
    0x03, 0x02, 0x01, 0x00,
    0x07, 0x07, 0x01, 0x03, 0x61, 0x64, 0x64, 0x00, 0x00,
    0x0a, 0x09, 0x01, 0x07, 0x00, 0x20, 0x00, 0x20, 0x01, 0x6a, 0x0b,
]);

function writeWorker(source: string): string {
    const file = Deno.makeTempFileSync({ prefix: 'cno-web-worker-', suffix: '.ts' });
    writeFileSync(file, source);
    return file;
}

Deno.test({ name: 'Worker upstream: data URL worker echoes messages and receives name', timeout: 10000 }, async () => {
    const source = `
        if (self.name !== 'data-worker') {
            throw new Error('invalid worker name: ' + self.name);
        }
        self.onmessage = (event) => {
            self.postMessage({
                data: event.data,
                memoryKeys: Object.keys(Deno.memoryUsage()),
            });
            self.close();
        };
    `;
    const worker = new Worker(`data:application/typescript;base64,${btoa(source)}`, {
        type: 'module',
        name: 'data-worker',
    });
    try {
        const reply: any = await new Promise((resolve, reject) => {
            worker.onmessage = (event) => resolve(event.data);
            worker.onerror = reject;
            worker.postMessage('Hello World');
        });
        strictEqual(reply.data, 'Hello World');
        strictEqual(JSON.stringify(reply.memoryKeys.sort()), JSON.stringify(['external', 'heapTotal', 'heapUsed', 'rss']));
    } finally {
        worker.terminate();
    }
});

Deno.test({ name: 'Worker upstream: blob URL worker can dynamically import blob modules', timeout: 10000 }, async () => {
    const moduleCode = `
        console.log('module start');
        const hash = await crypto.subtle.digest('SHA-1', new TextEncoder().encode('data'));
        console.log('module finish');
        export default { hashLength: hash.byteLength, value: 'blob-module' };
    `;
    const workerUrl = URL.createObjectURL(new Blob([`
        self.postMessage('worker ready');
        self.onmessage = async (event) => {
            self.postMessage('before import');
            const moduleUrl = URL.createObjectURL(new Blob([event.data.moduleCode]));
            const mod = await import(moduleUrl);
            URL.revokeObjectURL(moduleUrl);
            self.postMessage({ value: mod.default.value, hashLength: mod.default.hashLength });
            self.close();
        };
    `]));
    const worker = new Worker(workerUrl, { type: 'module' });
    try {
        const messages: unknown[] = await new Promise((resolve, reject) => {
            const out: unknown[] = [];
            worker.onerror = reject;
            worker.onmessage = (event) => {
                out.push(event.data);
                if (event.data === 'worker ready') worker.postMessage({ moduleCode });
                else if (typeof event.data === 'object') resolve(out);
            };
        });
        strictEqual(JSON.stringify(messages), JSON.stringify([
            'worker ready',
            'before import',
            { value: 'blob-module', hashLength: 20 },
        ]));
    } finally {
        worker.terminate();
        URL.revokeObjectURL(workerUrl);
    }
});

Deno.test({ name: 'Worker: postMessage transfers ArrayBuffer views', timeout: 10000 }, async () => {
    const file = writeWorker(`
        self.onmessage = (event) => {
            const view = event.data.view;
            self.postMessage({
                isUint8Array: view instanceof Uint8Array,
                byteOffset: view.byteOffset,
                length: view.length,
                second: view[1],
                bufferLength: view.buffer.byteLength,
            });
        };
    `);
    const worker = new Worker(file);
    try {
        const buffer = new ArrayBuffer(8);
        const view = new Uint8Array(buffer, 2, 3);
        view.set([10, 11, 12]);
        const reply: any = await new Promise((resolve, reject) => {
            worker.onmessage = (event) => resolve(event.data);
            worker.onerror = reject;
            worker.postMessage({ view }, [buffer]);
        });
        ok(reply.isUint8Array);
        strictEqual(reply.byteOffset, 2);
        strictEqual(reply.length, 3);
        strictEqual(reply.second, 11);
        strictEqual(reply.bufferLength, 8);
        strictEqual(buffer.byteLength, 0);
    } finally {
        worker.terminate();
        unlinkSync(file);
    }
});

Deno.test({ name: 'Worker: postMessage accepts transfer options object', timeout: 10000 }, async () => {
    const file = writeWorker(`
        self.onmessage = (event) => {
            const view = event.data.view;
            self.postMessage({
                byteOffset: view.byteOffset,
                length: view.length,
                first: view[0],
                bufferLength: view.buffer.byteLength,
            });
        };
    `);
    const worker = new Worker(file);
    try {
        const buffer = new ArrayBuffer(8);
        const view = new Uint8Array(buffer, 2, 3);
        view.set([51, 52, 53]);
        const reply: any = await new Promise((resolve, reject) => {
            worker.onmessage = (event) => resolve(event.data);
            worker.onerror = reject;
            worker.postMessage({ view }, { transfer: [buffer] });
        });
        strictEqual(reply.byteOffset, 2);
        strictEqual(reply.length, 3);
        strictEqual(reply.first, 51);
        strictEqual(reply.bufferLength, 8);
        strictEqual(buffer.byteLength, 0);
    } finally {
        worker.terminate();
        unlinkSync(file);
    }
});

Deno.test({ name: 'Worker: postMessage transfer-only ArrayBuffer detaches without payload reference', timeout: 10000 }, async () => {
    const file = writeWorker(`
        self.onmessage = (event) => {
            self.postMessage({
                tag: event.data.tag,
                hasBuffer: 'buffer' in event.data,
            });
        };
    `);
    const worker = new Worker(file);
    try {
        const buffer = new ArrayBuffer(4);
        new Uint8Array(buffer).set([1, 2, 3, 4]);
        const reply: any = await new Promise((resolve, reject) => {
            worker.onmessage = (event) => resolve(event.data);
            worker.onerror = reject;
            worker.postMessage({ tag: 'buffer-only' }, [buffer]);
        });
        strictEqual(buffer.byteLength, 0);
        strictEqual(reply.tag, 'buffer-only');
        strictEqual(reply.hasBuffer, false);
    } finally {
        worker.terminate();
        unlinkSync(file);
    }
});

Deno.test({ name: 'Worker: postMessage preserves shared backing buffer without transfer', timeout: 10000 }, async () => {
    const file = writeWorker(`
        self.onmessage = (event) => {
            const a = event.data.a;
            const b = event.data.b;
            self.postMessage({
                sameBuffer: a.buffer === b.buffer,
                aOffset: a.byteOffset,
                bOffset: b.byteOffset,
                bFourth: b[3],
            });
        };
    `);
    const worker = new Worker(file);
    try {
        const buffer = new ArrayBuffer(8);
        const a = new Uint8Array(buffer, 0, 4);
        const b = new Uint8Array(buffer, 2, 4);
        a.set([1, 2, 3, 4]);
        b.set([5, 6], 2);
        const reply: any = await new Promise((resolve, reject) => {
            worker.onmessage = (event) => resolve(event.data);
            worker.onerror = reject;
            worker.postMessage({ a, b });
        });
        ok(reply.sameBuffer);
        strictEqual(reply.aOffset, 0);
        strictEqual(reply.bOffset, 2);
        strictEqual(reply.bFourth, 6);
        strictEqual(buffer.byteLength, 8);
    } finally {
        worker.terminate();
        unlinkSync(file);
    }
});

Deno.test({ name: 'Worker: postMessage clones structured data types', timeout: 10000 }, async () => {
    const file = writeWorker(`
        self.onmessage = (event) => {
            const data = event.data;
            const mapKey = Array.from(data.map.keys())[0];
            self.postMessage({
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
        };
    `);
    const worker = new Worker(file);
    try {
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
        const regex = /worker-data/gy;
        regex.lastIndex = 3;
        const error = new TypeError('bad main payload') as TypeError & { code?: string; cause?: unknown };
        error.code = 'DROP_ME';
        error.cause = { reason: 'nested' };
        const reply: any = await new Promise((resolve, reject) => {
            worker.onmessage = (event) => resolve(event.data);
            worker.onerror = reject;
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
        strictEqual(reply.regexSource, 'worker-data');
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
        worker.terminate();
        unlinkSync(file);
    }
});

Deno.test({ name: 'Worker: postMessage is queued until worker installs onmessage', timeout: 10000 }, async () => {
    const file = writeWorker(`
        queueMicrotask(() => {
            self.onmessage = (event) => {
                self.postMessage({ value: event.data });
            };
        });
    `);
    const worker = new Worker(file);
    try {
        const reply: any = await new Promise((resolve, reject) => {
            worker.onmessage = (event) => resolve(event.data);
            worker.onerror = reject;
            worker.postMessage('queued');
        });
        strictEqual(reply.value, 'queued');
    } finally {
        worker.terminate();
        unlinkSync(file);
    }
});

Deno.test({ name: 'Worker upstream: postMessage undefined round-trips without messageerror', timeout: 10000 }, async () => {
    const file = writeWorker(`
        self.onmessage = () => {
            self.postMessage(undefined);
        };
    `);
    const worker = new Worker(file, { type: 'module' });
    try {
        const reply = await new Promise<unknown>((resolve, reject) => {
            worker.onmessage = (event) => resolve(event.data);
            worker.onmessageerror = () => reject(new Error('unexpected messageerror'));
            worker.onerror = reject;
            worker.postMessage(undefined);
        });
        strictEqual(reply, undefined);
    } finally {
        worker.terminate();
        unlinkSync(file);
    }
});

Deno.test({ name: 'Worker: message event handlers run in registration order', timeout: 10000 }, async () => {
    const file = writeWorker(`
        self.onmessage = (event) => {
            self.postMessage(event.data);
        };
    `);
    const worker = new Worker(file);
    const order: number[] = [];
    try {
        const done = new Promise<void>((resolve, reject) => {
            worker.addEventListener('message', () => order.push(1));
            worker.onmessage = () => order.push(2);
            worker.addEventListener('message', () => order.push(3));
            worker.addEventListener('message', () => resolve());
            worker.onerror = reject;
        });
        worker.postMessage('order');
        await done;
        strictEqual(JSON.stringify(order), JSON.stringify([1, 2, 3]));
    } finally {
        worker.terminate();
        unlinkSync(file);
    }
});

Deno.test({ name: 'Worker upstream: handler can run while module top-level await is pending', timeout: 10000 }, async () => {
    const file = writeWorker(`
        self.onmessage = () => {
            self.postMessage('triggered worker handler');
            self.close();
        };
        self.postMessage('ready');
        await new Promise((resolve) => setTimeout(resolve, 1000));
        self.postMessage('never');
    `);
    const worker = new Worker(file, { type: 'module' });
    try {
        await new Promise<void>((resolve, reject) => {
            worker.onerror = reject;
            worker.onmessage = (event) => {
                if (event.data === 'ready') worker.postMessage('trigger worker handler');
                else if (event.data === 'triggered worker handler') resolve();
                else reject(new Error(`unexpected worker message: ${String(event.data)}`));
            };
        });
    } finally {
        worker.terminate();
        unlinkSync(file);
    }
});

Deno.test({ name: 'Worker: name globals and navigator are available in worker scope', timeout: 10000 }, async () => {
    const file = writeWorker(`
        self.postMessage({
            name: self.name,
            postMessage: typeof self.postMessage,
            close: typeof self.close,
            workerConstructor: typeof Worker,
            userAgent: typeof navigator.userAgent,
            hardwareConcurrency: typeof navigator.hardwareConcurrency,
        });
    `);
    const worker = new Worker(file, { type: 'module', name: 'scope-worker' });
    try {
        const reply: any = await new Promise((resolve, reject) => {
            worker.onmessage = (event) => resolve(event.data);
            worker.onerror = reject;
        });
        strictEqual(reply.name, 'scope-worker');
        strictEqual(reply.postMessage, 'function');
        strictEqual(reply.close, 'function');
        strictEqual(reply.workerConstructor, 'function');
        strictEqual(reply.userAgent, 'string');
        strictEqual(reply.hardwareConcurrency, 'number');
    } finally {
        worker.terminate();
        unlinkSync(file);
    }
});

Deno.test('Worker upstream: terminate is idempotent and Worker has web toStringTag', () => {
    const file = writeWorker(`setTimeout(() => {}, 1000);`);
    const worker = new Worker(file, { type: 'module' });
    try {
        strictEqual(Object.prototype.toString.call(worker), '[object Worker]');
        worker.terminate();
        worker.terminate();
    } finally {
        worker.terminate();
        unlinkSync(file);
    }
});

Deno.test({ name: 'Worker: nested workers can exchange messages', timeout: 10000 }, async () => {
    const dir = Deno.makeTempDirSync({ prefix: 'cno-web-worker-nested-' });
    const childFile = `${dir}/child.ts`;
    const parentFile = `${dir}/parent.ts`;
    writeFileSync(childFile, `
        self.onmessage = (event) => {
            self.postMessage({ name: self.name, value: event.data });
        };
    `);
    writeFileSync(parentFile, `
        self.onmessage = (event) => {
            const child = new Worker(${JSON.stringify(childFile)}, { type: 'module', name: 'nested-child' });
            child.onmessage = (message) => {
                self.postMessage({ type: 'nested', data: message.data });
                child.terminate();
            };
            child.onerror = (error) => {
                self.postMessage({ type: 'error', message: error.message });
            };
            child.postMessage(event.data);
        };
    `);
    const worker = new Worker(parentFile, { type: 'module', name: 'nested-parent' });
    try {
        const reply: any = await new Promise((resolve, reject) => {
            worker.onmessage = (event) => resolve(event.data);
            worker.onerror = reject;
            worker.postMessage('hello nested');
        });
        strictEqual(reply.type, 'nested');
        strictEqual(reply.data.name, 'nested-child');
        strictEqual(reply.data.value, 'hello nested');
    } finally {
        worker.terminate();
        Deno.removeSync(dir, { recursive: true });
    }
});

Deno.test({ name: 'Worker: runtime errors dispatch cancelable error events', timeout: 10000 }, async () => {
    const file = writeWorker(`
        setTimeout(() => {
            throw new Error('worker boom');
        }, 0);
    `);
    const worker = new Worker(file, { type: 'module' });
    try {
        const event = await new Promise<ErrorEvent>((resolve, reject) => {
            worker.onmessage = () => reject(new Error('unexpected worker message'));
            worker.onerror = (error) => {
                error.preventDefault();
                resolve(error);
            };
        });
        strictEqual(event.message, 'worker boom');
        ok(event.error instanceof Error);
        strictEqual((event.error as Error).message, 'worker boom');
        strictEqual(event.defaultPrevented, true);
    } finally {
        worker.terminate();
        unlinkSync(file);
    }
});

Deno.test({ name: 'Worker: unhandled rejections dispatch error events', timeout: 10000 }, async () => {
    const file = writeWorker(`
        setTimeout(() => {
            Promise.reject(new Error('worker rejection'));
        }, 0);
    `);
    const worker = new Worker(file, { type: 'module' });
    try {
        const event = await new Promise<ErrorEvent>((resolve, reject) => {
            worker.onmessage = () => reject(new Error('unexpected worker message'));
            worker.onerror = (error) => {
                error.preventDefault();
                resolve(error);
            };
        });
        strictEqual(event.message, 'worker rejection');
        ok(event.error instanceof Error);
        strictEqual((event.error as Error).message, 'worker rejection');
        strictEqual(event.defaultPrevented, true);
    } finally {
        worker.terminate();
        unlinkSync(file);
    }
});

Deno.test({ name: 'Worker: preventDefault on rejection error suppresses core stderr', timeout: 15000 }, async () => {
    const dir = Deno.makeTempDirSync({ prefix: 'cno-web-worker-error-' });
    const workerFile = `${dir}/reject-worker.ts`;
    const mainFile = `${dir}/main.ts`;
    writeFileSync(workerFile, `
        setTimeout(() => {
            Promise.reject(new Error('quiet worker rejection'));
        }, 0);
    `);
    writeFileSync(mainFile, `
        const worker = new Worker(${JSON.stringify(workerFile)}, { type: 'module' });
        await new Promise((resolve, reject) => {
            const timeout = setTimeout(() => reject(new Error('worker error timeout')), 5000);
            worker.onmessage = () => reject(new Error('unexpected worker message'));
            worker.onerror = (event) => {
                event.preventDefault();
                clearTimeout(timeout);
                resolve(undefined);
            };
        });
        worker.terminate();
        console.log('worker-error-handled');
    `);

    try {
        const output = await new Deno.Command(Deno.execPath(), {
            args: ['run', '--no-lock', mainFile],
            stdout: 'piped',
            stderr: 'piped',
            env: { CTS_SILENT: 'true' },
        }).output();
        const stdout = decodeUtf8(output.stdout);
        const stderr = decodeUtf8(output.stderr);
        strictEqual(output.code, 0, stderr);
        ok(stdout.includes('worker-error-handled'), stdout);
        strictEqual(stderr.includes('[CORE] PROMISE_REJECTION'), false, stderr);
        strictEqual(stderr.includes('quiet worker rejection'), false, stderr);
    } finally {
        Deno.removeSync(dir, { recursive: true });
    }
});

Deno.test({ name: 'Worker: self.postMessage transfers ArrayBuffer views', timeout: 10000 }, async () => {
    const file = writeWorker(`
        const buffer = new ArrayBuffer(8);
        const view = new Uint8Array(buffer, 2, 3);
        view.set([31, 32, 33]);
        self.postMessage({ view }, [buffer]);
        self.postMessage({ afterDetach: buffer.byteLength });
    `);
    const worker = new Worker(file);
    try {
        const messages: any[] = await new Promise((resolve, reject) => {
            const out: any[] = [];
            worker.onmessage = (event) => {
                out.push(event.data);
                if (out.length === 2) resolve(out);
            };
            worker.onerror = reject;
        });
        const received = messages[0].view;
        ok(received instanceof Uint8Array);
        strictEqual(received.byteOffset, 2);
        strictEqual(received.length, 3);
        strictEqual(received[1], 32);
        strictEqual(received.buffer.byteLength, 8);
        strictEqual(messages[1].afterDetach, 0);
    } finally {
        worker.terminate();
        unlinkSync(file);
    }
});

Deno.test({ name: 'Worker: self.postMessage accepts transfer options object', timeout: 10000 }, async () => {
    const file = writeWorker(`
        const buffer = new ArrayBuffer(8);
        const view = new Uint8Array(buffer, 2, 3);
        view.set([61, 62, 63]);
        self.postMessage({ view }, { transfer: [buffer] });
        self.postMessage({ afterDetach: buffer.byteLength });
    `);
    const worker = new Worker(file);
    try {
        const messages: any[] = await new Promise((resolve, reject) => {
            const out: any[] = [];
            worker.onmessage = (event) => {
                out.push(event.data);
                if (out.length === 2) resolve(out);
            };
            worker.onerror = reject;
        });
        const received = messages[0].view;
        ok(received instanceof Uint8Array);
        strictEqual(received.byteOffset, 2);
        strictEqual(received.length, 3);
        strictEqual(received[2], 63);
        strictEqual(received.buffer.byteLength, 8);
        strictEqual(messages[1].afterDetach, 0);
    } finally {
        worker.terminate();
        unlinkSync(file);
    }
});

Deno.test({ name: 'Worker upstream: message handler errors dispatch cancelable error events', timeout: 10000 }, async () => {
    const file = writeWorker(`
        self.postMessage('ready');
        self.onmessage = () => {
            throw new Error('message handler boom');
        };
    `);
    const worker = new Worker(file, { type: 'module', name: 'handler-error-worker' });
    try {
        const event = await new Promise<ErrorEvent>((resolve, reject) => {
            worker.onmessage = () => worker.postMessage('go');
            worker.onerror = (error) => {
                error.preventDefault();
                resolve(error);
            };
            setTimeout(() => reject(new Error('worker error timeout')), 5000);
        });
        strictEqual(event.message, 'message handler boom');
        ok(event.error instanceof Error);
        strictEqual((event.error as Error).message, 'message handler boom');
        strictEqual(event.defaultPrevented, true);
    } finally {
        worker.terminate();
        unlinkSync(file);
    }
});

Deno.test({ name: 'Worker: WebAssembly API is available inside worker', timeout: 10000 }, async () => {
    const file = writeWorker(`
        const bytes = new Uint8Array([${Array.from(ADD_WASM).join(',')}]);
        const { instance } = await WebAssembly.instantiate(bytes);
        self.postMessage({
            instantiate: typeof WebAssembly.instantiate,
            value: instance.exports.add(9, 10),
        });
    `);
    const worker = new Worker(file);
    try {
        const reply: any = await new Promise((resolve, reject) => {
            worker.onmessage = (event) => resolve(event.data);
            worker.onerror = reject;
        });
        strictEqual(reply.instantiate, 'function');
        strictEqual(reply.value, 19);
    } finally {
        worker.terminate();
        unlinkSync(file);
    }
});

Deno.test({ name: 'Worker upstream: terminating pending TLA workers is stable', timeout: 10000 }, async () => {
    const source = `
        await new Promise((resolve) => setTimeout(resolve, 1000));
        self.postMessage('late');
    `;
    const url = `data:application/typescript;base64,${btoa(source)}`;
    for (let i = 0; i < 10; i++) {
        const worker = new Worker(url, { type: 'module' });
        worker.terminate();
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
});

Deno.test({ name: 'Worker: WebAssembly streaming APIs work inside worker', timeout: 10000 }, async () => {
    const file = writeWorker(`
        const bytes = new Uint8Array([${Array.from(ADD_WASM).join(',')}]);
        const response = () => new Response(bytes, {
            headers: { 'Content-Type': 'application/wasm' },
        });
        const module = await WebAssembly.compileStreaming(Promise.resolve(response()));
        const instance = await WebAssembly.instantiate(module);
        const streamed = await WebAssembly.instantiateStreaming(Promise.resolve(response()));
        self.postMessage({
            compiled: instance.exports.add(4, 6),
            streamed: streamed.instance.exports.add(8, 9),
        });
    `);
    const worker = new Worker(file);
    try {
        const reply: any = await new Promise((resolve, reject) => {
            worker.onmessage = (event) => resolve(event.data);
            worker.onerror = reject;
        });
        strictEqual(reply.compiled, 10);
        strictEqual(reply.streamed, 17);
    } finally {
        worker.terminate();
        unlinkSync(file);
    }
});

Deno.test({ name: 'Worker: can import WebAssembly modules', timeout: 10000 }, async () => {
    const dir = Deno.makeTempDirSync({ prefix: 'cno-web-worker-wasm-' });
    const wasmFile = `${dir}/add.wasm`;
    const workerFile = `${dir}/worker.ts`;
    writeFileSync(wasmFile, ADD_WASM);
    writeFileSync(workerFile, `
        import wasm, { add } from './add.wasm';
        self.postMessage({
            named: add(20, 22),
            defaultExport: wasm.add(5, 7),
        });
    `);
    const worker = new Worker(workerFile);
    try {
        const reply: any = await new Promise((resolve, reject) => {
            worker.onmessage = (event) => resolve(event.data);
            worker.onerror = reject;
        });
        strictEqual(reply.named, 42);
        strictEqual(reply.defaultExport, 12);
        worker.terminate();

        const { instance } = await WebAssembly.instantiate(ADD_WASM);
        strictEqual((instance.exports as { add: (a: number, b: number) => number }).add(1, 2), 3);
    } finally {
        worker.terminate();
        Deno.removeSync(dir, { recursive: true });
    }
});

Deno.test({ name: 'Worker: WebAssembly remains usable across sequential workers', timeout: 10000 }, async () => {
    const runWorker = async (left: number, right: number) => {
        const file = writeWorker(`
            const bytes = new Uint8Array([${Array.from(ADD_WASM).join(',')}]);
            const { instance } = await WebAssembly.instantiate(bytes);
            self.postMessage(instance.exports.add(${left}, ${right}));
        `);
        const worker = new Worker(file);
        try {
            return await new Promise<number>((resolve, reject) => {
                worker.onmessage = (event) => resolve(event.data);
                worker.onerror = reject;
            });
        } finally {
            worker.terminate();
            unlinkSync(file);
        }
    };

    strictEqual(await runWorker(2, 5), 7);
    strictEqual(await runWorker(11, 13), 24);

    const { instance } = await WebAssembly.instantiate(ADD_WASM);
    strictEqual((instance.exports as { add: (a: number, b: number) => number }).add(3, 4), 7);
});

Deno.test({ name: 'Worker: self.postMessage transfer-only ArrayBuffer detaches without payload reference', timeout: 10000 }, async () => {
    const file = writeWorker(`
        const buffer = new ArrayBuffer(4);
        new Uint8Array(buffer).set([1, 2, 3, 4]);
        self.postMessage({ tag: 'buffer-only' }, [buffer]);
        self.postMessage({ afterDetach: buffer.byteLength });
    `);
    const worker = new Worker(file);
    try {
        const messages: any[] = await new Promise((resolve, reject) => {
            const out: any[] = [];
            worker.onmessage = (event) => {
                out.push(event.data);
                if (out.length === 2) resolve(out);
            };
            worker.onerror = reject;
        });
        strictEqual(messages[0].tag, 'buffer-only');
        strictEqual('buffer' in messages[0], false);
        strictEqual(messages[1].afterDetach, 0);
    } finally {
        worker.terminate();
        unlinkSync(file);
    }
});

Deno.test({ name: 'Worker: self.postMessage preserves shared backing buffer without transfer', timeout: 10000 }, async () => {
    const file = writeWorker(`
        const buffer = new ArrayBuffer(8);
        const a = new Uint8Array(buffer, 0, 4);
        const b = new Uint8Array(buffer, 2, 4);
        a.set([1, 2, 3, 4]);
        b.set([5, 6], 2);
        self.postMessage({ a, b });
    `);
    const worker = new Worker(file);
    try {
        const received: any = await new Promise((resolve, reject) => {
            worker.onmessage = (event) => resolve(event.data);
            worker.onerror = reject;
        });
        ok(received.a instanceof Uint8Array);
        ok(received.b instanceof Uint8Array);
        strictEqual(received.a.buffer, received.b.buffer);
        strictEqual(received.a.byteOffset, 0);
        strictEqual(received.b.byteOffset, 2);
        strictEqual(received.b[3], 6);
    } finally {
        worker.terminate();
        unlinkSync(file);
    }
});

Deno.test({ name: 'Worker: self.postMessage clones structured data types', timeout: 10000 }, async () => {
    const file = writeWorker(`
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
        const regex = /from-worker/gi;
        regex.lastIndex = 4;
        const error = new RangeError('bad worker payload');
        error.code = 'DROP_ME';
        error.cause = { reason: 'worker-nested' };
        self.postMessage({
            date: new Date(654321),
            regex,
            error,
            instance,
            circular,
            ref,
            map: new Map([[ref, 'value']]),
            set: new Set([ref]),
        });
    `);
    const worker = new Worker(file);
    try {
        const data: any = await new Promise((resolve, reject) => {
            worker.onmessage = (event) => resolve(event.data);
            worker.onerror = reject;
        });
        ok(data.date instanceof Date);
        strictEqual(data.date.getTime(), 654321);
        ok(data.regex instanceof RegExp);
        strictEqual(data.regex.source, 'from-worker');
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
        worker.terminate();
        unlinkSync(file);
    }
});

Deno.test({ name: 'Worker: transferred MessagePort relays messages', timeout: 10000 }, async () => {
    const file = writeWorker(`
        self.onmessage = (event) => {
            const port = event.data.port;
            port.onmessage = (message) => {
                port.postMessage({ echo: message.data });
            };
        };
    `);
    const worker = new Worker(file);
    const channel = new MessageChannel();
    try {
        worker.postMessage({ port: channel.port1 }, [channel.port1]);
        const reply = new Promise<any>((resolve) => {
            channel.port2.onmessage = (event) => resolve(event.data);
        });
        channel.port2.postMessage('ping');
        strictEqual((await reply).echo, 'ping');
    } finally {
        worker.terminate();
        channel.port2.close();
        unlinkSync(file);
    }
});

Deno.test({ name: 'Worker: postMessage can transfer MessagePort with options object', timeout: 10000 }, async () => {
    const file = writeWorker(`
        self.onmessage = (event) => {
            const port = event.data.port;
            port.onmessage = (message) => {
                port.postMessage({ echo: message.data });
            };
        };
    `);
    const worker = new Worker(file);
    const channel = new MessageChannel();
    try {
        worker.postMessage({ port: channel.port1 }, { transfer: [channel.port1] });
        const reply = new Promise<any>((resolve) => {
            channel.port2.onmessage = (event) => resolve(event.data);
        });
        channel.port2.postMessage('ping-options');
        strictEqual((await reply).echo, 'ping-options');
    } finally {
        worker.terminate();
        channel.port2.close();
        unlinkSync(file);
    }
});

Deno.test({ name: 'Worker: postMessage exposes transfer-only MessagePort in event.ports', timeout: 10000 }, async () => {
    const file = writeWorker(`
        self.onmessage = (event) => {
            const port = event.ports[0];
            port.onmessage = (message) => {
                port.postMessage({ echo: message.data });
            };
            self.postMessage({
                tag: event.data.tag,
                portCount: event.ports.length,
                hasPayloadPort: 'port' in event.data,
            });
        };
    `);
    const worker = new Worker(file);
    const channel = new MessageChannel();
    try {
        const ready = new Promise<any>((resolve, reject) => {
            worker.onmessage = (event) => resolve(event.data);
            worker.onerror = reject;
        });
        worker.postMessage({ tag: 'transfer-only' }, [channel.port1]);
        let threw = false;
        try { channel.port1.postMessage('after-transfer'); } catch { threw = true; }
        ok(threw, 'source port must be detached even when only listed in transfer');
        const status = await ready;
        strictEqual(status.tag, 'transfer-only');
        strictEqual(status.portCount, 1);
        strictEqual(status.hasPayloadPort, false);

        const reply = new Promise<any>((resolve) => {
            channel.port2.onmessage = (event) => resolve(event.data);
        });
        channel.port2.postMessage('ping-transfer-only');
        strictEqual((await reply).echo, 'ping-transfer-only');
    } finally {
        worker.terminate();
        channel.port2.close();
        unlinkSync(file);
    }
});

Deno.test({ name: 'Worker: transferred MessagePort cannot be posted again from main', timeout: 10000 }, async () => {
    const file = writeWorker(`
        self.onmessage = (event) => {
            self.postMessage({ portCount: event.ports.length });
        };
    `);
    const worker = new Worker(file);
    const channel = new MessageChannel();
    try {
        const ready = new Promise<any>((resolve, reject) => {
            worker.onmessage = (event) => resolve(event.data);
            worker.onerror = reject;
        });
        worker.postMessage({ tag: 'first' }, [channel.port1]);
        strictEqual((await ready).portCount, 1);

        let threw = false;
        try { worker.postMessage({ tag: 'second' }, [channel.port1]); } catch { threw = true; }
        ok(threw, 'already transferred source port must not be transferable again');
    } finally {
        worker.terminate();
        channel.port2.close();
        unlinkSync(file);
    }
});

Deno.test({ name: 'Worker: postMessage exposes multiple transferred ports in order', timeout: 10000 }, async () => {
    const file = writeWorker(`
        self.onmessage = (event) => {
            const first = event.ports[0];
            const second = event.ports[1];
            first.onmessage = (message) => {
                first.postMessage({ from: 'first', value: message.data });
            };
            second.onmessage = (message) => {
                second.postMessage({ from: 'second', value: message.data });
            };
            self.postMessage({
                length: event.ports.length,
                firstMatches: event.data.first === first,
                secondMatches: event.data.second === second,
            });
        };
    `);
    const worker = new Worker(file);
    const first = new MessageChannel();
    const second = new MessageChannel();
    try {
        const ready = new Promise<any>((resolve, reject) => {
            worker.onmessage = (event) => resolve(event.data);
            worker.onerror = reject;
        });
        worker.postMessage({ first: first.port1, second: second.port1 }, [first.port1, second.port1]);
        const status = await ready;
        strictEqual(status.length, 2);
        ok(status.firstMatches);
        ok(status.secondMatches);

        const firstReply = new Promise<any>((resolve) => {
            first.port2.onmessage = (event) => resolve(event.data);
        });
        const secondReply = new Promise<any>((resolve) => {
            second.port2.onmessage = (event) => resolve(event.data);
        });
        first.port2.postMessage('one');
        second.port2.postMessage('two');
        strictEqual((await firstReply).from, 'first');
        strictEqual((await secondReply).from, 'second');
    } finally {
        worker.terminate();
        first.port2.close();
        second.port2.close();
        unlinkSync(file);
    }
});

Deno.test({ name: 'Worker: self.postMessage transfers MessagePort to main', timeout: 10000 }, async () => {
    const file = writeWorker(`
        const channel = new MessageChannel();
        channel.port1.onmessage = (event) => {
            channel.port1.postMessage({ echo: event.data });
        };
        self.postMessage({ port: channel.port2 }, [channel.port2]);
    `);
    const worker = new Worker(file);
    let transferred: MessagePort | null = null;
    try {
        transferred = await new Promise<MessagePort>((resolve, reject) => {
            worker.onmessage = (event) => {
                ok(event.data.port instanceof MessagePort);
                ok(event.ports[0] instanceof MessagePort);
                strictEqual(event.data.port, event.ports[0]);
                resolve(event.data.port);
            };
            worker.onerror = reject;
        });
        const reply = new Promise<any>((resolve) => {
            transferred!.onmessage = (event) => resolve(event.data);
        });
        transferred.postMessage('from-main');
        strictEqual((await reply).echo, 'from-main');
    } finally {
        worker.terminate();
        transferred?.close();
        unlinkSync(file);
    }
});

Deno.test({ name: 'Worker: self.postMessage exposes transfer-only MessagePort in event.ports', timeout: 10000 }, async () => {
    const file = writeWorker(`
        const channel = new MessageChannel();
        channel.port1.onmessage = (event) => {
            channel.port1.postMessage({ echo: event.data });
        };
        self.postMessage({ tag: 'transfer-only' }, [channel.port2]);
    `);
    const worker = new Worker(file);
    let transferred: MessagePort | null = null;
    try {
        const message = await new Promise<MessageEvent>((resolve, reject) => {
            worker.onmessage = (event) => resolve(event);
            worker.onerror = reject;
        });
        strictEqual(message.data.tag, 'transfer-only');
        strictEqual('port' in message.data, false);
        strictEqual(message.ports.length, 1);
        ok(message.ports[0] instanceof MessagePort);
        transferred = message.ports[0];

        const reply = new Promise<any>((resolve) => {
            transferred!.onmessage = (event) => resolve(event.data);
        });
        transferred.postMessage('from-main');
        strictEqual((await reply).echo, 'from-main');
    } finally {
        worker.terminate();
        transferred?.close();
        unlinkSync(file);
    }
});

Deno.test({ name: 'Worker: transferred MessagePort cannot be posted again from worker', timeout: 10000 }, async () => {
    const file = writeWorker(`
        const channel = new MessageChannel();
        self.postMessage({ tag: 'first' }, [channel.port2]);
        try {
            self.postMessage({ tag: 'second' }, [channel.port2]);
            self.postMessage({ threw: false });
        } catch (error) {
            self.postMessage({ threw: true, name: error.name });
        }
    `);
    const worker = new Worker(file);
    const transferred: MessagePort[] = [];
    try {
        const messages: any[] = await new Promise((resolve, reject) => {
            const out: any[] = [];
            worker.onmessage = (event) => {
                out.push(event);
                if (event.ports.length) transferred.push(event.ports[0]);
                if (out.length === 2) resolve(out);
            };
            worker.onerror = reject;
        });
        strictEqual(messages[0].data.tag, 'first');
        strictEqual(messages[0].ports.length, 1);
        strictEqual(messages[1].data.threw, true);
        strictEqual(messages[1].data.name, 'DataCloneError');
    } finally {
        worker.terminate();
        for (const port of transferred) port.close();
        unlinkSync(file);
    }
});

Deno.test({ name: 'Worker: self.postMessage exposes multiple transferred ports in order', timeout: 10000 }, async () => {
    const file = writeWorker(`
        const first = new MessageChannel();
        const second = new MessageChannel();
        first.port1.onmessage = (event) => {
            first.port1.postMessage({ from: 'first', value: event.data });
        };
        second.port1.onmessage = (event) => {
            second.port1.postMessage({ from: 'second', value: event.data });
        };
        self.postMessage({ first: first.port2, second: second.port2 }, [first.port2, second.port2]);
    `);
    const worker = new Worker(file);
    const transferred: MessagePort[] = [];
    try {
        await new Promise<void>((resolve, reject) => {
            worker.onmessage = (event) => {
                ok(event.data.first instanceof MessagePort);
                ok(event.data.second instanceof MessagePort);
                strictEqual(event.ports.length, 2);
                strictEqual(event.data.first, event.ports[0]);
                strictEqual(event.data.second, event.ports[1]);
                transferred.push(event.ports[0], event.ports[1]);
                resolve();
            };
            worker.onerror = reject;
        });
        const firstReply = new Promise<any>((resolve) => {
            transferred[0].onmessage = (event) => resolve(event.data);
        });
        const secondReply = new Promise<any>((resolve) => {
            transferred[1].onmessage = (event) => resolve(event.data);
        });
        transferred[0].postMessage('one');
        transferred[1].postMessage('two');
        strictEqual((await firstReply).from, 'first');
        strictEqual((await secondReply).from, 'second');
    } finally {
        worker.terminate();
        for (const port of transferred) port.close();
        unlinkSync(file);
    }
});

Deno.test({ name: 'Worker: transferred MessagePort relays ArrayBuffer transfers', timeout: 10000 }, async () => {
    const file = writeWorker(`
        self.onmessage = (event) => {
            const port = event.data.port;
            port.onmessage = (message) => {
                const view = message.data.view;
                port.postMessage({
                    isUint8Array: view instanceof Uint8Array,
                    byteOffset: view.byteOffset,
                    length: view.length,
                    second: view[1],
                    bufferLength: view.buffer.byteLength,
                });
            };
        };
    `);
    const worker = new Worker(file);
    const channel = new MessageChannel();
    try {
        worker.postMessage({ port: channel.port1 }, [channel.port1]);
        const buffer = new ArrayBuffer(8);
        const view = new Uint8Array(buffer, 2, 3);
        view.set([41, 42, 43]);
        const reply = new Promise<any>((resolve) => {
            channel.port2.onmessage = (event) => resolve(event.data);
        });
        channel.port2.postMessage({ view }, [buffer]);
        const data = await reply;
        ok(data.isUint8Array);
        strictEqual(data.byteOffset, 2);
        strictEqual(data.length, 3);
        strictEqual(data.second, 42);
        strictEqual(data.bufferLength, 8);
        strictEqual(buffer.byteLength, 0);
    } finally {
        worker.terminate();
        channel.port2.close();
        unlinkSync(file);
    }
});

Deno.test({ name: 'Worker: MessagePort without transfer list is rejected before closing', timeout: 10000 }, async () => {
    const file = writeWorker(`self.onmessage = () => {};`);
    const worker = new Worker(file);
    const channel = new MessageChannel();
    try {
        let threw = false;
        try { worker.postMessage({ port: channel.port1 }); } catch { threw = true; }
        ok(threw, 'MessagePort must be listed in the transfer list');

        const got = new Promise<any>((resolve) => {
            channel.port2.onmessage = (event) => resolve(event.data);
        });
        channel.port1.postMessage('still-open');
        strictEqual(await got, 'still-open');
    } finally {
        worker.terminate();
        channel.port1.close();
        channel.port2.close();
        unlinkSync(file);
    }
});

Deno.test({ name: 'Worker: duplicate MessagePort transfer throws before closing', timeout: 10000 }, async () => {
    const file = writeWorker(`self.onmessage = () => {};`);
    const worker = new Worker(file);
    const channel = new MessageChannel();
    try {
        let threw = false;
        try { worker.postMessage({ port: channel.port1 }, [channel.port1, channel.port1]); } catch { threw = true; }
        ok(threw, 'duplicate transferred MessagePort must throw');

        const got = new Promise<any>((resolve) => {
            channel.port2.onmessage = (event) => resolve(event.data);
        });
        channel.port1.postMessage('still-open');
        strictEqual(await got, 'still-open');
    } finally {
        worker.terminate();
        channel.port1.close();
        channel.port2.close();
        unlinkSync(file);
    }
});

Deno.test({ name: 'Worker: duplicate ArrayBuffer transfer throws before detach', timeout: 10000 }, () => {
    const file = writeWorker(`self.onmessage = () => {};`);
    const worker = new Worker(file);
    try {
        const buffer = new ArrayBuffer(4);
        let threw = false;
        try { worker.postMessage({ buffer }, [buffer, buffer]); } catch { threw = true; }
        ok(threw, 'duplicate transferred ArrayBuffer must throw');
        strictEqual(buffer.byteLength, 4);
    } finally {
        worker.terminate();
        unlinkSync(file);
    }
});

Deno.test({ name: 'Worker: Deno.exit is not catchable inside worker', timeout: 10000 }, async () => {
    const file = writeWorker(`
        try {
            Deno.exit(0);
        } catch (e) {
            self.postMessage({ caught: String(e && e.message || e) });
        }
        self.postMessage({ afterExit: true });
    `);
    const worker = new Worker(file);
    try {
        const message = await Promise.race([
            new Promise((resolve, reject) => {
                worker.onmessage = (event) => resolve(event.data);
                worker.onerror = reject;
            }),
            new Promise((resolve) => setTimeout(() => resolve(undefined), 150)),
        ]);
        strictEqual(message, undefined);
    } finally {
        worker.terminate();
        unlinkSync(file);
    }
});

Deno.test({ name: 'Worker upstream: data URL module worker receives name and messages', timeout: 10000 }, async () => {
    const source = `
        if (self.name !== 'data-url-worker') {
            throw new Error('unexpected worker name: ' + self.name);
        }
        self.onmessage = (event) => {
            self.postMessage({ name: self.name, data: event.data });
        };
    `;
    const worker = new Worker(
        `data:application/typescript;base64,${btoa(source)}`,
        { type: 'module', name: 'data-url-worker' },
    );
    try {
        const reply: any = await new Promise((resolve, reject) => {
            worker.onmessage = (event) => resolve(event.data);
            worker.onerror = reject;
            worker.postMessage('hello data url');
        });
        strictEqual(reply.name, 'data-url-worker');
        strictEqual(reply.data, 'hello data url');
    } finally {
        worker.terminate();
    }
});

Deno.test({ name: 'Worker upstream: undefined messages round-trip through postMessage', timeout: 10000 }, async () => {
    const file = writeWorker(`
        self.onmessage = (event) => {
            self.postMessage({
                isUndefined: event.data === undefined,
                hasDataProperty: 'data' in event,
            });
        };
    `);
    const worker = new Worker(file, { type: 'module' });
    try {
        const reply: any = await new Promise((resolve, reject) => {
            worker.onmessage = (event) => resolve(event.data);
            worker.onerror = reject;
            worker.postMessage(undefined);
        });
        strictEqual(reply.isUndefined, true);
        strictEqual(reply.hasDataProperty, true);
    } finally {
        worker.terminate();
        unlinkSync(file);
    }
});

Deno.test({ name: 'Worker upstream: crypto API is available in worker scope', timeout: 10000 }, async () => {
    const file = writeWorker(`
        const bytes = crypto.getRandomValues(new Uint8Array(8));
        self.postMessage({
            cryptoType: typeof crypto,
            getRandomValuesType: typeof crypto.getRandomValues,
            subtleType: typeof crypto.subtle,
            length: bytes.length,
            byteSum: bytes.reduce((sum, value) => sum + value, 0),
        });
    `);
    const worker = new Worker(file, { type: 'module' });
    try {
        const reply: any = await new Promise((resolve, reject) => {
            worker.onmessage = (event) => resolve(event.data);
            worker.onerror = reject;
        });
        strictEqual(reply.cryptoType, 'object');
        strictEqual(reply.getRandomValuesType, 'function');
        strictEqual(reply.subtleType, 'object');
        strictEqual(reply.length, 8);
        ok(reply.byteSum >= 0);
    } finally {
        worker.terminate();
        unlinkSync(file);
    }
});

Deno.test({ name: 'Worker upstream: top-level await runs before message handlers', timeout: 10000 }, async () => {
    const file = writeWorker(`
        let ready = false;
        await Promise.resolve().then(() => {
            ready = true;
        });
        self.postMessage('ready');
        self.onmessage = (event) => {
            self.postMessage({ ready, data: event.data });
        };
    `);
    const worker = new Worker(file, { type: 'module' });
    try {
        const messages: any[] = await new Promise((resolve, reject) => {
            const out: any[] = [];
            worker.onmessage = (event) => {
                out.push(event.data);
                if (event.data === 'ready') worker.postMessage('trigger');
                if (out.length === 2) resolve(out);
            };
            worker.onerror = reject;
        });
        strictEqual(messages[0], 'ready');
        strictEqual(messages[1].ready, true);
        strictEqual(messages[1].data, 'trigger');
    } finally {
        worker.terminate();
        unlinkSync(file);
    }
});

Deno.test({ name: 'Worker upstream: message and error listeners all receive events', timeout: 10000 }, async () => {
    const file = writeWorker(`
        self.onmessage = (event) => {
            if (event.data === 'boom') {
                throw new Error('worker listener boom');
            }
            self.postMessage('pong');
        };
    `);
    const worker = new Worker(file, { type: 'module' });
    try {
        const messageCalls: string[] = [];
        const messageDone = new Promise<void>((resolve, reject) => {
            worker.onmessage = () => messageCalls.push('onmessage');
            worker.addEventListener('message', () => messageCalls.push('listener-a'));
            worker.addEventListener('message', () => {
                messageCalls.push('listener-b');
                resolve();
            });
            worker.onerror = reject;
            worker.postMessage('ping');
        });
        await messageDone;
        strictEqual(JSON.stringify(messageCalls), JSON.stringify(['onmessage', 'listener-a', 'listener-b']));

        const errorCalls: string[] = [];
        const errorDone = new Promise<void>((resolve) => {
            worker.onerror = (event) => {
                event.preventDefault();
                errorCalls.push('onerror');
            };
            worker.addEventListener('error', () => errorCalls.push('error-listener-a'));
            worker.addEventListener('error', () => {
                errorCalls.push('error-listener-b');
                resolve();
            });
            worker.postMessage('boom');
        });
        await errorDone;
        strictEqual(JSON.stringify(errorCalls), JSON.stringify(['onerror', 'error-listener-a', 'error-listener-b']));
    } finally {
        worker.terminate();
        unlinkSync(file);
    }
});
