import { strictEqual, throws, ok, deepStrictEqual } from 'node:assert';
import { Console } from 'node:console';
import { PassThrough } from 'node:stream';

/**
 * Regression guards for four `Console` defects fixed in the TS layer
 * (cno/src/node/console/mod.ts). All expectations are node v24.18.0's behaviour.
 * These are NOT rebuild-dependent -- `cno setup` makes the fixes live -- so they
 * are unskipped and must stay green.
 *
 *   D18  inspectOptions was stored but never reached the formatter, so
 *        new Console({stdout, inspectOptions:{depth:0}}).log(o) ignored depth,
 *        compact, sorted and numericSeparator. Only dir() honoured them.
 *        Cause: buildOutput() called util.format() instead of
 *        util.formatWithOptions(). Measured before the fix:
 *          {depth:0} on {a:{b:1}}  node `{ a: [Object] }`  cno `{ a: { b: 1 } }`
 *   D19  Methods were prototype-only, so Object.keys(c) and {...c} exposed
 *        cno's private fields (_stdout, _timers, ...) instead of node's method
 *        set, and `const f = c.log; f()` threw TypeError on the lost `this`.
 *   D20  A bad or missing stdout was accepted; node throws TypeError with code
 *        ERR_CONSOLE_WRITABLE_STREAM before assigning any field.
 *   D21  Console(...) without `new` threw; node returns an instance. Note a
 *        `this instanceof` guard inside the constructor CANNOT fix this -- a real
 *        ES class throws at [[Call]] before the body runs -- hence the Proxy.
 */

function sink(): { stream: PassThrough; text: () => string } {
    const stream = new PassThrough();
    let buf = '';
    stream.on('data', (d: Buffer) => { buf += d.toString('utf8'); });
    return { stream, text: () => buf };
}

/** Console writes synchronously to a PassThrough, so one tick is enough. */
const flush = () => new Promise<void>((r) => setTimeout(r, 10));

Deno.test('D18: inspectOptions.depth reaches console.log', async () => {
    const { stream, text } = sink();
    new Console({ stdout: stream, stderr: stream, inspectOptions: { depth: 0 } })
        .log({ a: { b: 1 } });
    await flush();
    strictEqual(text().trimEnd(), '{ a: [Object] }');
});

Deno.test('D18: inspectOptions.compact reaches console.log', async () => {
    const { stream, text } = sink();
    new Console({ stdout: stream, stderr: stream, inspectOptions: { compact: false } })
        .log({ a: 1, b: 2 });
    await flush();
    strictEqual(text().trimEnd(), '{\n  a: 1,\n  b: 2\n}');
});

Deno.test('D18: inspectOptions applies to error/warn as well as log', async () => {
    const { stream, text } = sink();
    const c = new Console({ stdout: stream, stderr: stream, inspectOptions: { depth: 0 } });
    c.error({ a: { b: 1 } });
    c.warn({ a: { b: 1 } });
    await flush();
    strictEqual(text().trimEnd(), '{ a: [Object] }\n{ a: [Object] }');
});

Deno.test('D18: no inspectOptions still formats at node defaults', async () => {
    const { stream, text } = sink();
    new Console({ stdout: stream, stderr: stream }).log({ a: { b: { c: { d: 1 } } } });
    await flush();
    // node's default depth is 2, so the 4th level collapses
    strictEqual(text().trimEnd(), '{ a: { b: { c: [Object] } } }');
});

Deno.test('D19: instance own enumerable keys are node\'s method set', () => {
    const c = new Console({ stdout: new PassThrough() });
    deepStrictEqual(Object.keys(c).sort(), [
        'assert', 'clear', 'count', 'countReset', 'debug', 'dir', 'dirxml', 'error',
        'group', 'groupCollapsed', 'groupEnd', 'info', 'log', 'table', 'time',
        'timeEnd', 'timeLog', 'trace', 'warn',
    ]);
});

Deno.test('D19: internals are non-enumerable', () => {
    const c = new Console({ stdout: new PassThrough() });
    for (const key of Object.keys(c)) ok(!key.startsWith('_'), `leaked internal: ${key}`);
    // still present, just hidden
    ok(Object.getOwnPropertyNames(c).includes('_stdout'));
});

Deno.test('D19: a detached method keeps working', async () => {
    const { stream, text } = sink();
    const c = new Console({ stdout: stream, stderr: stream });
    const { log } = c;
    log('detached');
    await flush();
    strictEqual(text().trimEnd(), 'detached');
});

Deno.test('D19: log is an own enumerable writable configurable property', () => {
    const c = new Console({ stdout: new PassThrough() });
    const d = Object.getOwnPropertyDescriptor(c, 'log');
    ok(d, 'log should be an own property');
    strictEqual(d!.enumerable, true);
    strictEqual(d!.writable, true);
    strictEqual(d!.configurable, true);
});

Deno.test('D20: a missing or non-writable stdout throws ERR_CONSOLE_WRITABLE_STREAM', () => {
    const expect = (fn: () => unknown) => throws(fn, (e: Error & { code?: string }) => {
        strictEqual(e.name, 'TypeError');
        strictEqual(e.code, 'ERR_CONSOLE_WRITABLE_STREAM');
        return true;
    });
    expect(() => new Console({} as never));
    expect(() => new Console(undefined as never));
    expect(() => new (Console as never as new () => unknown)());
    expect(() => new Console({ stdout: {} } as never));
    expect(() => new Console({ stdout: new PassThrough(), stderr: {} } as never));
});

Deno.test('D20: the throw happens before any field is assigned', () => {
    // A half-built Console would surface later as a confusing write-time failure.
    try {
        new Console({ stdout: {} } as never);
        ok(false, 'should have thrown');
    } catch (e) {
        strictEqual((e as { code?: string }).code, 'ERR_CONSOLE_WRITABLE_STREAM');
    }
});

Deno.test('D21: Console is callable without new', async () => {
    const { stream, text } = sink();
    const Callable = Console as unknown as (o: { stdout: PassThrough }) => InstanceType<typeof Console>;
    const c = Callable({ stdout: stream });
    ok(c instanceof Console);
    strictEqual(Console.name, 'Console');
    c.log('no-new');
    await flush();
    strictEqual(text().trimEnd(), 'no-new');
});

Deno.test('D21: new Console still works and is instanceof', () => {
    ok(new Console({ stdout: new PassThrough() }) instanceof Console);
});

Deno.test('D22: node:console does not export the ConsoleOptions type as a value', async () => {
    const mod = await import('node:console') as unknown as Record<string, unknown>;
    strictEqual('ConsoleOptions' in mod, false);
    strictEqual(typeof mod.Console, 'function');
});
