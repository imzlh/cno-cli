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
    throws(() => dns.lookup(''), { name: 'TypeError', code: 'ERR_INVALID_ARG_TYPE' });
    throws(() => dns.lookup('localhost', { family: 5 as 4 }), /InvalidFamily/);
    throws(() => dns.lookup('localhost', { port: 65536 }), { code: 'ERR_SOCKET_BAD_PORT' });
    throws(() => dns.lookup('localhost', { flags: 128 }), { code: 'ERR_INVALID_ARG_VALUE' });
    throws(() => dns.lookup('localhost', { flags: 2 ** 32 }), { code: 'ERR_INVALID_ARG_VALUE' });
    throws(() => dns.lookup('localhost', { backend: 'c-ares' }), /c-ares backend is unsupported/);
    await rejects(dns.lookup(`127.0.0.1\0.invalid`), { name: 'DNSException', code: 'DNS_ENOTFOUND' });
    await rejects(dns.lookup('nonexistent.invalid', { backend: 'system' }), { name: 'DNSException', code: 'DNS_ENOTFOUND' });
});
