import { notStrictEqual, ok, strictEqual } from 'node:assert';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

// cno builtins use `export * as default from './mod'` which produces a sealed
// namespace exotic object.  CTS's CJS bridge gives require() a mutable copy
// (Object.assign({}, defaultExport)) so CommonJS consumers can patch it without
// touching the frozen ESM namespace.  This is a DELIBERATE divergence from Node
// (where require() === import.default holds).  These tests pin the cno contract:
//
//  1. require('X') returns an extensible ordinary object (not a namespace).
//  2. require('X') is cached: repeated calls return the same copy.
//  3. Mutating the require copy does NOT leak into the ESM namespace.
//  4. Named exports on the ESM side are still present.

const BUILTINS = [
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

Deno.test('builtins: require() returns a distinct cached mutable copy', async () => {
    for (const name of BUILTINS) {
        const cjs = require(name) as object;
        const ns = await import(`node:${name}`) as { default: object };
        // The copy is NOT the namespace itself
        notStrictEqual(cjs, ns.default,
            `require('${name}') must not be the sealed ESM namespace`);
        // But it IS cached across calls
        strictEqual(require(name), cjs,
            `require('${name}') must return the same cached copy`);
        strictEqual(require(`node:${name}`), cjs,
            `require('node:${name}') must share the cache with bare form`);
    }
});

Deno.test('builtins: require() copy is an extensible ordinary object', () => {
    for (const name of BUILTINS) {
        const cjs = require(name) as object;
        ok(Object.isExtensible(cjs),
            `require('${name}') must be extensible`);
        ok(!Object.isSealed(cjs),
            `require('${name}') must not be sealed`);
        ok(Object.prototype.toString.call(cjs) !== '[object Module]',
            `require('${name}') must not be a module namespace exotic object`);
    }
});

Deno.test('builtins: mutating require() copy does not leak into ESM namespace', async () => {
    for (const name of BUILTINS) {
        const cjs = require(name) as Record<string, unknown>;
        const ns = await import(`node:${name}`) as { default: Record<string, unknown> };
        const probe = `__cnoRequireCopyProbe_${name}`;
        cjs[probe] = 1;
        strictEqual(cjs[probe], 1,
            `require('${name}') must accept property assignment`);
        strictEqual(ns.default[probe], undefined,
            `require('${name}') mutation must not leak into ESM namespace`);
        delete cjs[probe];
    }
});

Deno.test('builtins: named exports still resolve on import', async () => {
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
        ok(ns[exp] !== undefined,
            `node:${name} — named export '${exp}' must be present`);
        // Also present on the require copy
        const cjs = require(name) as Record<string, unknown>;
        ok(cjs[exp] !== undefined,
            `require('${name}').${exp} must be present on the copy`);
    }
});

Deno.test('readline still re-exports its promises namespace', async () => {
    const ns = await import('node:readline') as { promises?: Record<string, unknown> };
    ok(ns.promises !== undefined, 'node:readline must still expose the promises namespace');
});
