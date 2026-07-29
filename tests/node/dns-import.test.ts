import { ok, strictEqual } from 'node:assert';
import * as dns from 'node:dns';

Deno.test('dns import initializes callback and promises namespaces', () => {
    strictEqual(typeof dns.lookup, 'function');
    strictEqual(typeof dns.Resolver, 'function');
    strictEqual(typeof dns.promises.lookup, 'function');
    ok(Array.isArray(dns.getServers()));
});
