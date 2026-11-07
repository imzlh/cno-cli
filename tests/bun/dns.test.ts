import { deepStrictEqual, ok, rejects, strictEqual, throws } from 'node:assert';
import Bun, { dns } from 'bun';

Deno.test('bun dns lookup resolves addresses with system resolver', async () => {
    strictEqual(Bun.dns, dns);
    const result = await dns.lookup('127.0.0.1', { family: 4, backend: 'system' });
    deepStrictEqual(result, [{ address: '127.0.0.1', family: 4, ttl: 0 }]);
    const localhost = await dns.lookup('localhost', { family: 'IPv4' });
    ok(localhost.length > 0);
    ok(localhost.every((item) => item.family === 4 && item.ttl === 0));
    strictEqual(dns.ADDRCONFIG, 32);
    strictEqual(dns.ALL, 16);
    strictEqual(dns.V4MAPPED, 8);
});

Deno.test('bun dns lookup validates and rejects failed resolution', async () => {
    throws(() => dns.lookup(1 as unknown as string), {
        name: 'TypeError',
        code: 'ERR_INVALID_ARG_TYPE',
        message: 'hostname must be a string',
    });
    throws(() => dns.lookup(''), { name: 'TypeError', code: 'ERR_INVALID_ARG_TYPE' });
    throws(() => dns.lookup('localhost', { family: false as unknown as 4 }), {
        name: 'TypeError',
        code: 'ERR_INVALID_ARG_TYPE',
    });
    throws(() => dns.lookup('localhost', { family: 5 as 4 }), /InvalidFamily/);
    throws(() => dns.lookup('localhost', { family: 'IPV4' as 'IPv4' }), /InvalidFamily/);
    const nativeMathTrunc = Math.trunc;
    let mathTruncCalls = 0;
    let invalidFamily: unknown;
    Math.trunc = () => {
        mathTruncCalls++;
        throw new Error('patched Math.trunc called');
    };
    try {
        dns.lookup('127.0.0.1', { family: 5.5 as 4 });
    } catch (error) {
        invalidFamily = error;
    } finally {
        Math.trunc = nativeMathTrunc;
    }
    strictEqual(mathTruncCalls, 0);
    throws(() => { throw invalidFamily; }, {
        name: 'Error',
        message: 'Invalid options passed to lookup(): InvalidFamily',
    });
    throws(() => dns.lookup('localhost', { port: '80' as unknown as number }), {
        name: 'TypeError',
        code: 'ERR_INVALID_ARG_TYPE',
    });
    throws(() => dns.lookup('localhost', { port: 65536 }), { code: 'ERR_SOCKET_BAD_PORT' });
    throws(() => dns.lookup('localhost', { flags: 128 }), { code: 'ERR_INVALID_ARG_VALUE' });
    throws(() => dns.lookup('localhost', { flags: 2 ** 32 }), { code: 'ERR_INVALID_ARG_VALUE' });
    throws(() => dns.lookup('localhost', { protocol: 'bad' } as never), /InvalidProtocol/);
    deepStrictEqual(await dns.lookup(new String('127.0.0.1') as unknown as string, { family: 4, backend: 'c-ares' }), [
        { address: '127.0.0.1', family: 4, ttl: 0 },
    ]);

    const nulHostname = `127.0.0.1\0.invalid`;
    await rejects(dns.lookup(nulHostname), (error: Error & Record<string, unknown>) => {
        strictEqual(error.name, 'DNSException');
        strictEqual(error.code, 'DNS_ENOTFOUND');
        strictEqual(error.errno, 4);
        strictEqual(error.syscall, 'getaddrinfo');
        strictEqual(error.hostname, nulHostname);
        deepStrictEqual(Object.keys(error), ['code', 'syscall', 'hostname', 'errno', 'name']);
        return true;
    });
});

Deno.test('bun dns lookup observes Bun option order and property descriptors', () => {
    const events: string[] = [];
    const options = new Proxy({}, {
        get(_target, property) {
            events.push(String(property));
            if (property === 'port') return 70000;
            if (property === 'family') return 4;
            if (property === 'socketType') return 'tcp';
            if (property === 'protocol') return 0;
            if (property === 'backend') return 'system';
            if (property === 'flags') return 0;
        },
    });
    throws(() => dns.lookup('127.0.0.1', options as never), { code: 'ERR_SOCKET_BAD_PORT' });
    deepStrictEqual(events, ['port', 'family', 'socketType', 'protocol', 'backend', 'flags']);

    const descriptor = Object.getOwnPropertyDescriptor(dns, 'lookup')!;
    strictEqual(descriptor.value, dns.lookup);
    strictEqual(descriptor.writable, true);
    strictEqual(descriptor.enumerable, true);
    strictEqual(descriptor.configurable, false);
    strictEqual(dns.lookup.name, 'lookup');
    strictEqual(dns.lookup.length, 2);
    strictEqual(Object.hasOwn(dns.lookup, 'prototype'), false);
    throws(() => new (dns.lookup as unknown as new () => unknown)(), TypeError);
});
