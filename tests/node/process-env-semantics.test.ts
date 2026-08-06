/**
 * process.env semantics, measured against real Node v24.18.0 on win32.
 *
 * Every expectation here was captured differentially from `node` on the same
 * host (probes: D:/tmp/ag-env1.cjs .. ag-env5.cjs), not asserted from memory.
 *
 * The Proxy target must stay permanently EMPTY. `ownKeys` reports only the OS
 * environment, so an own property parked on the target breaks the ES invariant
 * "ownKeys must report every non-configurable own key" and makes Object.keys,
 * for..in, spread and JSON.stringify throw for the REST OF THE PROCESS. The
 * defineProperty tests below are the regression guard for that.
 */
import { ok, strictEqual, throws } from 'node:assert';
import * as nodeProcess from 'node:process';

const isWindows = process.platform === 'win32';

// The tests below deliberately exercise the GLOBAL `process.env`, because that
// is the object real user code touches. Note that cno currently exposes TWO
// distinct env Proxy instances (see the identity test immediately below), and
// `cno run` resolves the global to a copy baked into the binary while
// `import ... from 'node:process'` resolves to the live src/node/process/mod.ts.
// A fix to the proxy therefore only reaches user code after a REBUILD.

Deno.test('process.env: the global and node:process share one env object', () => {
    strictEqual(
        globalThis.process as unknown as object,
        (nodeProcess as unknown as { default: object }).default,
        'the process object itself should be shared',
    );
    // Compared with ok(), not strictEqual(), so a failure does not dump the
    // entire environment (which may hold tokens) into the test log.
    ok(
        (globalThis.process as unknown as { env: object }).env
            === (nodeProcess as unknown as { env: object }).env,
        'globalThis.process.env and node:process env are different Proxy instances',
    );
});

// --- case-insensitivity on Windows ------------------------------------------

Deno.test('process.env: PATH/Path/path agree on Windows', () => {
    if (!isWindows) return;
    strictEqual(typeof process.env.PATH, 'string');
    strictEqual(process.env.PATH, process.env.Path);
    strictEqual(process.env.PATH, process.env.path);
});

Deno.test('process.env: a cross-case write hits the same slot', () => {
    if (!isWindows) return;
    process.env.CnoCase1 = 'first';
    strictEqual(process.env.CNOCASE1, 'first');
    strictEqual(process.env.cnocase1, 'first');
    process.env.CNOCASE1 = 'second';
    strictEqual(process.env.CnoCase1, 'second');
    // exactly one key, keeping the ORIGINAL writer's casing
    const matching = Object.keys(process.env).filter(k => k.toUpperCase() === 'CNOCASE1');
    strictEqual(matching.length, 1, `expected 1 key, got ${JSON.stringify(matching)}`);
    strictEqual(matching[0], 'CnoCase1');
    delete process.env.CNOCASE1;
});

Deno.test('process.env: a cross-case delete removes the variable', () => {
    if (!isWindows) return;
    process.env.CnoCase2 = 'v';
    delete process.env.cnocase2;
    strictEqual('CNOCASE2' in process.env, false);
    strictEqual(process.env.CnoCase2, undefined);
    strictEqual(Object.keys(process.env).filter(k => k.toUpperCase() === 'CNOCASE2').length, 0);
});

// --- enumeration ------------------------------------------------------------

Deno.test('process.env: keys are unique, readable, and free of unusable names', () => {
    const keys = Object.keys(process.env);
    ok(keys.length > 0);
    ok(keys.every(k => typeof k === 'string'));
    strictEqual(keys.length, new Set(keys).size, 'exact duplicate key');
    if (isWindows) {
        strictEqual(keys.length, new Set(keys.map(k => k.toUpperCase())).size, 'case-duplicate key');
    }
    ok(!keys.includes(''), 'empty key name enumerated');
    ok(!keys.some(k => k.includes('=')), 'key name containing = enumerated');
    // enumeration and access must agree: a listed key must be readable
    const unreadable = keys.filter(k => process.env[k] === undefined);
    strictEqual(unreadable.length, 0, `listed but unreadable: ${JSON.stringify(unreadable.slice(0, 5))}`);
});

Deno.test('process.env: for..in, getOwnPropertyNames and entries agree with keys', () => {
    const keys = Object.keys(process.env);
    const forIn: string[] = [];
    for (const k in process.env) forIn.push(k);
    strictEqual(JSON.stringify(forIn), JSON.stringify(keys));
    strictEqual(JSON.stringify(Object.getOwnPropertyNames(process.env)), JSON.stringify(keys));
    strictEqual(Object.entries(process.env).length, keys.length);
    ok(Object.values(process.env).every(v => typeof v === 'string'));
});

Deno.test('process.env: spread and Object.assign copy every key', () => {
    process.env.CnoSpread = 'sv';
    const spread = { ...process.env };
    strictEqual(spread.CnoSpread, 'sv');
    strictEqual(Object.keys(spread).length, Object.keys(process.env).length);
    strictEqual(Object.keys(Object.assign({}, process.env)).length, Object.keys(process.env).length);
    strictEqual(typeof JSON.stringify(process.env), 'string');
    delete process.env.CnoSpread;
});

// --- value coercion (Node applies ToString; undefined does NOT delete) ------

Deno.test('process.env: values are coerced with ToString', () => {
    process.env.CnoNum = 42 as unknown as string;
    strictEqual(process.env.CnoNum, '42');
    process.env.CnoObj = { a: 1 } as unknown as string;
    strictEqual(process.env.CnoObj, '[object Object]');
    process.env.CnoArr = [1, 2] as unknown as string;
    strictEqual(process.env.CnoArr, '1,2');
    process.env.CnoBool = true as unknown as string;
    strictEqual(process.env.CnoBool, 'true');
    process.env.CnoNull = null as unknown as string;
    strictEqual(process.env.CnoNull, 'null');
    process.env.CnoTP = { [Symbol.toPrimitive]: () => 'viaToPrimitive' } as unknown as string;
    strictEqual(process.env.CnoTP, 'viaToPrimitive');
    for (const k of ['CnoNum', 'CnoObj', 'CnoArr', 'CnoBool', 'CnoNull', 'CnoTP']) delete process.env[k];
});

Deno.test('process.env: assigning undefined stores "undefined" and does not delete', () => {
    process.env.CnoUndef = 'present';
    process.env.CnoUndef = undefined as unknown as string;
    strictEqual(process.env.CnoUndef, 'undefined');
    strictEqual('CnoUndef' in process.env, true);
    delete process.env.CnoUndef;
});

Deno.test('process.env: a symbol value throws rather than becoming "Symbol(x)"', () => {
    throws(
        () => { process.env.CnoSym = Symbol('s') as unknown as string; },
        (e: unknown) => e instanceof TypeError && /Cannot convert a Symbol value to a string/.test((e as Error).message),
    );
    strictEqual(process.env.CnoSym, undefined);
});

Deno.test('process.env: a symbol key throws and is not parked on the target', () => {
    const key = Symbol('cno-key');
    throws(
        () => { (process.env as Record<symbol, string>)[key] = 'v'; },
        (e: unknown) => e instanceof TypeError && /Cannot convert a Symbol value to a string/.test((e as Error).message),
    );
    strictEqual(Object.getOwnPropertySymbols(process.env).length, 0);
    // and enumeration is still intact
    ok(Object.keys(process.env).length > 0);
});

Deno.test('process.env: an empty-string value round-trips and enumerates', () => {
    process.env.CnoEmpty = '';
    strictEqual(process.env.CnoEmpty, '');
    strictEqual('CnoEmpty' in process.env, true);
    ok(Object.keys(process.env).includes('CnoEmpty'));
    delete process.env.CnoEmpty;
});

Deno.test('process.env: a non-ASCII value round-trips', () => {
    process.env.CnoUni = 'café-日本';
    strictEqual(process.env.CnoUni, 'café-日本');
    delete process.env.CnoUni;
});

// --- unusable names fail silently, the way Node fails ----------------------

Deno.test('process.env: a key containing = is a silent no-op, not a throw', () => {
    // Node v24.18/win32: the assignment does not throw and the read is undefined.
    process.env['CnoA=B'] = 'z';
    strictEqual(process.env['CnoA=B'], undefined);
    ok(!Object.keys(process.env).includes('CnoA=B'));
});

Deno.test('process.env: an empty key is a silent no-op, not a throw', () => {
    process.env[''] = 'ek';
    strictEqual(process.env[''], undefined);
    ok(!Object.keys(process.env).includes(''));
});

Deno.test('process.env: deleting a missing variable returns true', () => {
    strictEqual(delete process.env.CNO_NO_SUCH_VARIABLE_XYZ, true);
});

// --- descriptors ------------------------------------------------------------

Deno.test('process.env: an existing variable reports a full writable descriptor', () => {
    process.env.CnoDesc = 'dv';
    const d = Object.getOwnPropertyDescriptor(process.env, 'CnoDesc');
    ok(d, 'descriptor missing');
    strictEqual(d.value, 'dv');
    strictEqual(d.writable, true, 'writable must be spelled out; omitting it defaults to false');
    strictEqual(d.enumerable, true);
    strictEqual(d.configurable, true);
    delete process.env.CnoDesc;
});

Deno.test('process.env: a missing variable has no descriptor', () => {
    strictEqual(Object.getOwnPropertyDescriptor(process.env, 'CNO_NO_SUCH_VARIABLE_XYZ'), undefined);
});

// --- defineProperty: the poison regression --------------------------------

Deno.test('process.env: defineProperty rejects a non-full descriptor and stays usable', () => {
    const before = Object.keys(process.env).length;
    throws(
        () => Object.defineProperty(process.env, 'CnoPoison', { value: 'p' }),
        (e: unknown) => (e as { code?: string }).code === 'ERR_INVALID_OBJECT_DEFINE_PROPERTY',
    );
    // The critical part: the rejection must not have poisoned the target.
    ok(Object.keys(process.env).length >= before, 'Object.keys broke after a rejected defineProperty');
    let n = 0;
    for (const _k in process.env) n++;
    ok(n > 0, 'for..in broke after a rejected defineProperty');
    ok(Object.keys({ ...process.env }).length > 0, 'spread broke');
    strictEqual(typeof JSON.stringify(process.env), 'string');
    strictEqual(process.env.CnoPoison, undefined);
});

Deno.test('process.env: defineProperty rejects an accessor descriptor', () => {
    throws(
        () => Object.defineProperty(process.env, 'CnoAcc', { get: () => 'g', configurable: true, enumerable: true }),
        (e: unknown) => (e as { code?: string }).code === 'ERR_INVALID_OBJECT_DEFINE_PROPERTY'
            && /accessor/.test((e as Error).message),
    );
    ok(Object.keys(process.env).length > 0);
});

Deno.test('process.env: a full data descriptor writes through to the environment', () => {
    Object.defineProperty(process.env, 'CnoDefOk', {
        value: 'dv5', writable: true, enumerable: true, configurable: true,
    });
    strictEqual(process.env.CnoDefOk, 'dv5');
    ok(Object.keys(process.env).includes('CnoDefOk'), 'defineProperty wrote to the target, not the OS');
    delete process.env.CnoDefOk;
});

Deno.test('process.env: preventExtensions throws and the object stays extensible', () => {
    throws(() => Object.preventExtensions(process.env), TypeError);
    strictEqual(Object.isExtensible(process.env), true);
    strictEqual(Object.isFrozen(process.env), false);
    strictEqual(Object.isSealed(process.env), false);
});

// --- propagation to a child ------------------------------------------------

Deno.test('process.env: a set propagates to a spawned child', async () => {
    process.env.CnoChildVar = 'childValue';
    const cmd = new Deno.Command(process.execPath, {
        args: ['run', '-'],
        stdin: 'piped',
        stdout: 'piped',
        stderr: 'piped',
    });
    const child = cmd.spawn();
    const w = child.stdin.getWriter();
    await w.write(new TextEncoder().encode('console.log(String(process.env.CnoChildVar));\n'));
    await w.close();
    const out = await child.output();
    const text = new TextDecoder().decode(out.stdout).trim();
    strictEqual(text, 'childValue', `child stderr: ${new TextDecoder().decode(out.stderr).slice(0, 200)}`);
    delete process.env.CnoChildVar;
});
