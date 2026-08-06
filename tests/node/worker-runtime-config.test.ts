import { ok, strictEqual, deepStrictEqual } from 'node:assert';
import { Worker } from 'node:worker_threads';

// Regression coverage for RUNTIME CONFIG INHERITANCE across the worker boundary.
//
// A worker runs on its own JSRuntime and re-derives its config by calling
// createConfig, which re-parses os.args. os.args in a worker is the FULL parent
// argument vector, but cts's parseArgs (cts/src/utils/misc.ts) stops at the first
// positional token — and for `cno run <entry>` that token is `run`. So the
// re-parse sees no flags at all and every CLI-supplied setting reverts to a
// default. The only channel that carries the parent's resolved config across the
// boundary is the `__cts_runtime_config` key in the worker bootstrap record
// (published by publishWorkerRuntimeConfig in src/commands/run.ts, read back by
// workerRuntimeConfig in src/main.ts).
//
// node:worker_threads previously did not send that key at all, while the webapi
// Worker did. Measured consequences on the node path before the fix:
//   * `--memory-limit=64MB`: parent threw InternalError at 55MB, the worker
//     allocated 600MB without throwing.
//   * `--no-oxc`: the parent transformed TS with the Sucrase fallback while the
//     worker used oxc, so the two threads did not agree on their compiler.
//
// These tests assert on the wire record rather than on re-measured behaviour so
// they stay fast and do not depend on which flags the suite itself was invoked
// with.

/** Keys publishWorkerRuntimeConfig is responsible for carrying. */
const CARRIED_KEYS = [
    'cacheDir', 'lockDir', 'enableHttp', 'enableJsr', 'enableNode', 'enableCache',
    'cachedOnly', 'enableOxc', 'frozen', 'disableLock', 'ignoreScripts', 'polyfill',
    'conditions', 'importMap', 'importMapScopes', 'pathAliases', 'baseUrl',
    'memoryLimit', 'maxStackSize',
] as const;

/**
 * Reads the raw worker bootstrap record from inside a worker. This is the record
 * as it crossed the thread boundary, before worker_threads/mod.ts filters
 * INTERNAL_KEYS out of the user-visible workerData.
 */
function readWireRecord(): Promise<Record<string, unknown>> {
    const worker = new Worker(
        `const wt = require('node:worker_threads');
         const raw = import.meta.use('worker').workerData;
         wt.parentPort.postMessage({
             keys: Object.keys(raw),
             cfg: raw.__cts_runtime_config ?? null,
         });`,
        { eval: true },
    );
    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
            worker.terminate();
            reject(new Error('worker did not report its bootstrap record in time'));
        }, 20000);
        worker.on('message', (msg: Record<string, unknown>) => {
            clearTimeout(timer);
            worker.terminate();
            resolve(msg);
        });
        worker.on('error', (e) => { clearTimeout(timer); reject(e); });
    });
}

Deno.test({
    name: 'worker_threads: bootstrap record carries __cts_runtime_config',
    timeout: 30000,
}, async () => {
    const { keys, cfg } = await readWireRecord() as { keys: string[]; cfg: unknown };
    ok(
        keys.includes('__cts_runtime_config'),
        `node worker bootstrap record must carry __cts_runtime_config, got: ${keys.join(',')}`,
    );
    // The key being enumerable is not enough: an object literal that assigns
    // `undefined` still lists the key, so assert a real value came across too.
    ok(cfg !== null && cfg !== undefined, '__cts_runtime_config must carry a value, not undefined');
});

Deno.test({
    name: 'worker_threads: inherited config is a populated object, not undefined',
    timeout: 30000,
}, async () => {
    const { cfg } = await readWireRecord() as { cfg: Record<string, unknown> | null };
    ok(cfg !== null, 'inherited runtime config must not be null/undefined');
    ok(typeof cfg === 'object', 'inherited runtime config must be an object');
    ok(Object.keys(cfg).length > 0, 'inherited runtime config must not be empty');
});

Deno.test({
    name: 'worker_threads: cacheDir crosses the boundary as an absolute path',
    timeout: 30000,
}, async () => {
    const { cfg } = await readWireRecord() as { cfg: Record<string, unknown> };
    const cacheDir = cfg.cacheDir;
    strictEqual(typeof cacheDir, 'string', 'cacheDir must be inherited as a string');
    ok((cacheDir as string).length > 0, 'cacheDir must not be empty');
    // Node builtins resolve from `${cacheDir}/node`, so a relative value here
    // would make the worker resolve polyfills against its own cwd.
    ok(
        /^([a-zA-Z]:[\\/]|\/)/.test(cacheDir as string),
        `cacheDir must be absolute so polyfill resolution is cwd-independent, got ${cacheDir}`,
    );
});

Deno.test({
    name: 'worker_threads: enableOxc crosses the boundary so both threads use one TS compiler',
    timeout: 30000,
}, async () => {
    const { cfg } = await readWireRecord() as { cfg: Record<string, unknown> };
    // Without this the worker silently disagrees with the parent about whether
    // TS goes through oxc or the interpreted Sucrase fallback. Sucrase compiles
    // `namespace N { export const x = 1 }` to `";"`, so the use site throws
    // ReferenceError — a miscompile, not just a slowdown.
    strictEqual(typeof cfg.enableOxc, 'boolean', 'enableOxc must be inherited as a boolean');
});

Deno.test({
    name: 'worker_threads: resource limits cross the boundary',
    timeout: 30000,
}, async () => {
    const { cfg } = await readWireRecord() as { cfg: Record<string, unknown> };
    // A worker gets its own JSRuntime with mem_limit = 0 (unlimited) until the
    // inherited value is applied, which is how a 16MB cap allowed 500MB.
    strictEqual(typeof cfg.memoryLimit, 'number', 'memoryLimit must be inherited as a number');
    strictEqual(typeof cfg.maxStackSize, 'number', 'maxStackSize must be inherited as a number');
    ok((cfg.memoryLimit as number) >= 0, 'memoryLimit must be non-negative');
    ok((cfg.maxStackSize as number) >= 0, 'maxStackSize must be non-negative');
});

Deno.test({
    name: 'worker_threads: every carried config key is either present or explicitly unset',
    timeout: 30000,
}, async () => {
    const { cfg } = await readWireRecord() as { cfg: Record<string, unknown> };
    // A key may legitimately be absent when the parent never set it (the wire
    // record is JSON-shaped, so undefined values drop out). What must not happen
    // is an unexpected key appearing, which would mean the publisher and this
    // list have drifted apart.
    const known = new Set<string>(CARRIED_KEYS);
    const unexpected = Object.keys(cfg).filter((k) => !known.has(k));
    deepStrictEqual(unexpected, [], `unexpected keys on the wire: ${unexpected.join(',')}`);
});

Deno.test({
    name: 'worker_threads: internal bootstrap keys are hidden from user workerData',
    timeout: 30000,
}, async () => {
    // The inherited config must not leak into the user's workerData object —
    // it is transport, not user payload.
    const worker = new Worker(
        `const wt = require('node:worker_threads');
         wt.parentPort.postMessage({
             keys: Object.keys(wt.workerData ?? {}),
             userValue: (wt.workerData ?? {}).mine ?? null,
         });`,
        { eval: true, workerData: { mine: 'payload' } },
    );
    const msg = await new Promise<{ keys: string[]; userValue: unknown }>((resolve, reject) => {
        const timer = setTimeout(() => { worker.terminate(); reject(new Error('timeout')); }, 20000);
        worker.on('message', (m: { keys: string[]; userValue: unknown }) => {
            clearTimeout(timer); worker.terminate(); resolve(m);
        });
        worker.on('error', (e) => { clearTimeout(timer); reject(e); });
    });
    strictEqual(msg.userValue, 'payload', 'user workerData must survive intact');
    ok(
        !msg.keys.includes('__cts_runtime_config'),
        `__cts_runtime_config must not be visible in workerData, got: ${msg.keys.join(',')}`,
    );
    ok(
        !msg.keys.some((k) => k.startsWith('__cts_') || k.startsWith('__node_')),
        `no internal bootstrap key may leak into workerData, got: ${msg.keys.join(',')}`,
    );
});
