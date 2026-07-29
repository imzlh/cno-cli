import { ok, strictEqual } from 'node:assert';
import * as dns from 'node:dns/promises';

Deno.test('dns promises import initializes independently', () => {
    strictEqual(typeof dns.lookup, 'function');
    strictEqual(typeof dns.Resolver, 'function');
    strictEqual(typeof dns.resolveAny, 'function');
    ok(Array.isArray(dns.getServers()));
});
