import { ok, strictEqual } from 'node:assert';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

// A builtin's ESM default export and its `require()` value must be the SAME
// object, and that object must be extensible. Measured on node v24.18.0: for
// every builtin, `(await import('node:X')).default === require('X')` is true and
// `Object.isExtensible(default)` is true.
//
// cno diverged because these modules were written as:
//     export * as default from './mod';
// `export * as default` makes the default export a *module namespace exotic
// object*, which the ECMAScript spec defines as non-extensible with
// non-configurable properties. Two consequences, both measured:
//
//  1. `import util from 'node:util'; util.format = fn` silently failed, where
//     node allows it.
//  2. cts's CJS bridge adopts the ESM default as `module.exports` only when it is
//     extensible; for a sealed namespace it falls back to
//     `Object.assign({}, defaultExport)` (cts/src/compile/cjs.ts:772). That
//     permanently forked the `require('util')` object from the
//     `import 'node:util'` one — measured `default === require` was FALSE for
//     fs, os, util, http, zlib, url, querystring, dns, child_process while node
//     reported true for all of them.
//
// Why it matters beyond property identity: sharing one object is what lets a
// patch applied through `require()` be observed by ESM importers. That is the
// mechanism every APM / instrumentation layer relies on (require-in-the-middle,
// OpenTelemetry, nock, mock-fs, sinon stubs on builtins). With the fork, such a
// patch was invisible to any `import`-side consumer and the instrumentation
// silently did nothing.
//
// The fix is `export default { ...mod }` — an ordinary extensible object. Applied
// to the modules below. `cluster` and `domain` are deliberately NOT included:
// their mod.ts carries mutable `export let`/`var` bindings, so an object spread
// would snapshot a value that later changes.
//
// NOTE ON SCOPE: `buffer` and `console` still use the namespace form and still
// fail these invariants; they were left alone because they carry other work.
// `fs`, `zlib`, `url`, `http`, `https`, `net`, `tls`, `dns`, `timers`,
// `child_process`, `worker_threads`, `crypto`, `stream` and `async_hooks` are
// likewise still on the old form.

const FIXED = [
    'os',
    'util',
    'querystring',
    'string_decoder',
    'punycode',
    'perf_hooks',
    'v8',
    'vm',
    'readline',
    'repl',
    'tty',
    'dgram',
    'diagnostics_channel',
    'inspector',
    'trace_events',
] as const;

Deno.test('builtins: ESM default export is the same object require() returns', async () => {
    for (const name of FIXED) {
        const cjs = require(name) as object;
        const ns = await import(`node:${name}`) as { default: object };
        strictEqual(
            ns.default,
            cjs,
            `node:${name} — import default must be the same object as require('${name}')`,
        );
    }
});

Deno.test('builtins: ESM default export is extensible, not a sealed namespace', async () => {
    for (const name of FIXED) {
        const ns = await import(`node:${name}`) as { default: object };
        const d = ns.default;
        ok(Object.isExtensible(d), `node:${name} — default export must be extensible`);
        ok(!Object.isSealed(d), `node:${name} — default export must not be sealed`);
        // A module namespace object reports this exact tag; a plain object does not.
        ok(
            Object.prototype.toString.call(d) !== '[object Module]',
            `node:${name} — default must not be a module namespace exotic object`,
        );
    }
});

Deno.test('builtins: a new property can be added to the default export', async () => {
    for (const name of FIXED) {
        const ns = await import(`node:${name}`) as { default: Record<string, unknown> };
        const probe = '__cnoIdentityProbe__';
        ns.default[probe] = 1;
        strictEqual(ns.default[probe], 1, `node:${name} — assignment to default must stick`);
        delete ns.default[probe];
        // defineProperty is what several instrumentation libraries use.
        Object.defineProperty(ns.default, probe, { value: 2, configurable: true, writable: true });
        strictEqual(ns.default[probe], 2, `node:${name} — defineProperty on default must work`);
        delete ns.default[probe];
    }
});

Deno.test('builtins: a require()-side patch is observable through the ESM default view', async () => {
    for (const name of FIXED) {
        const cjs = require(name) as Record<string, unknown>;
        const ns = await import(`node:${name}`) as { default: Record<string, unknown> };

        const key = Object.keys(cjs).find(
            (k) => typeof cjs[k] === 'function' && typeof ns.default[k] === 'function',
        );
        ok(key !== undefined, `node:${name} — expected at least one shared function export`);

        const original = cjs[key] as (...a: unknown[]) => unknown;
        try {
            const patch = function patched(this: unknown, ...a: unknown[]) {
                return original.apply(this, a);
            };
            cjs[key] = patch;
            strictEqual(
                ns.default[key],
                patch,
                `node:${name} — patching require('${name}').${key} must be visible on the ESM default`,
            );
        } finally {
            cjs[key] = original;
        }
        strictEqual(ns.default[key], original, `node:${name} — restore must also be visible`);
    }
});

Deno.test('builtins: named exports still resolve after the default-export change', async () => {
    // Guards against a rewrite that drops `export * from './mod'`.
    const expectations: Array<[string, string]> = [
        ['os', 'platform'],
        ['util', 'inspect'],
        ['querystring', 'stringify'],
        ['string_decoder', 'StringDecoder'],
        ['punycode', 'toASCII'],
        ['perf_hooks', 'performance'],
        ['v8', 'serialize'],
        ['vm', 'runInNewContext'],
        ['readline', 'createInterface'],
        ['repl', 'start'],
        ['tty', 'isatty'],
        ['dgram', 'createSocket'],
        ['diagnostics_channel', 'channel'],
        ['inspector', 'Session'],
        ['trace_events', 'createTracing'],
    ];
    for (const [name, exp] of expectations) {
        const ns = await import(`node:${name}`) as Record<string, unknown>;
        ok(ns[exp] !== undefined, `node:${name} — named export '${exp}' must be present`);
        const d = ns.default as Record<string, unknown>;
        ok(d[exp] !== undefined, `node:${name} — '${exp}' must also be on the default export`);
    }
});

Deno.test('readline still re-exports its promises namespace', async () => {
    const ns = await import('node:readline') as { promises?: Record<string, unknown> };
    ok(ns.promises !== undefined, 'node:readline must still expose the promises namespace');
    ok(
        typeof ns.promises.createInterface === 'function',
        'node:readline/promises.createInterface must be callable',
    );
});
