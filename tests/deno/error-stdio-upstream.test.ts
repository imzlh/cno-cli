import { fail, strictEqual, ok, throws } from 'node:assert';

const errorNames = [
    'NotFound',
    'PermissionDenied',
    'ConnectionRefused',
    'ConnectionReset',
    'ConnectionAborted',
    'NotConnected',
    'AddrInUse',
    'AddrNotAvailable',
    'BrokenPipe',
    'AlreadyExists',
    'InvalidData',
    'TimedOut',
    'Interrupted',
    'WriteZero',
    'WouldBlock',
    'UnexpectedEof',
    'BadResource',
    'Http',
    'Busy',
    'NotSupported',
    'FilesystemLoop',
    'IsADirectory',
    'NetworkUnreachable',
    'NotADirectory',
    'NotCapable',
] as const;

Deno.test('deno upstream: Deno.errors constructors preserve cause', () => {
    for (const name of errorNames) {
        const Ctor = Deno.errors[name];
        const cause = { name };
        const error = new Ctor('msg', { cause });
        ok(error instanceof Error);
        strictEqual(error.name, name);
        strictEqual(error.message, 'msg');
        strictEqual(error.cause, cause);
    }
});

Deno.test('deno upstream: Deno.errors options lookup ignores Object prototype pollution', () => {
    const objectProto = Object.prototype as Object.prototype & { cause?: unknown };
    objectProto.cause = 'polluted';
    try {
        const error = new Deno.errors.NotFound('msg', {});
        strictEqual(Object.prototype.hasOwnProperty.call(error, 'cause'), false);
    } finally {
        delete objectProto.cause;
    }
});

Deno.test('deno upstream: assertion errors tolerate Object prototype getter pollution', () => {
    const objectProto = Object.prototype as Object.prototype & { get?: unknown };
    let caught: unknown;
    objectProto.get = () => {};
    try {
        try {
            fail('test error');
            throw new Error('expected fail() to throw');
        } catch (error) {
            caught = error;
        }
    } finally {
        delete objectProto.get;
    }
    ok(caught instanceof Error);
    strictEqual(caught.message, 'test error');
});

Deno.test('deno upstream: stdio zero-length reads and writes return zero', async () => {
    const empty = new Uint8Array(0);
    strictEqual(await Deno.stdin.read(empty), 0);
    strictEqual(Deno.stdin.readSync(empty), 0);
    strictEqual(await Deno.stdout.write(empty), 0);
    strictEqual(Deno.stdout.writeSync(empty), 0);
    strictEqual(await Deno.stderr.write(empty), 0);
    strictEqual(Deno.stderr.writeSync(empty), 0);
});

Deno.test('deno upstream: consoleSize only reports dimensions for terminal stdout', () => {
    if (Deno.stdout.isTerminal()) {
        const size = Deno.consoleSize();
        ok(Number.isInteger(size.columns));
        ok(Number.isInteger(size.rows));
    } else {
        throws(() => Deno.consoleSize());
    }
});
