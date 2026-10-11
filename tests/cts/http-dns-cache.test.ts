import { deepStrictEqual, rejects, throws } from 'node:assert';
import { clearDnsCache, dnsCache } from '../../http/src/dns-cache.ts';

Deno.test('http DNS cache: compressed IPv6 literals validate both sides', async () => {
    for (const hostname of ['gg::1:2', '1:2::gg', '1.2.3.4::1']) {
        await rejects(dnsCache.resolve(hostname), hostname);
        throws(() => dnsCache.resolveSync(hostname), hostname);
    }
});

Deno.test('http DNS cache: valid IPv6 literals bypass resolution', async () => {
    for (const hostname of ['::', '2001:db8::1', '::ffff:192.0.2.1', '1:2:3:4:5:6:7:8']) {
        const expected = [{ ip: hostname, family: 6 }];
        deepStrictEqual(await dnsCache.resolve(hostname), expected);
        deepStrictEqual(dnsCache.resolveSync(hostname), expected);
    }
});

Deno.test('http DNS cache: synchronous resolution uses the requested native address family', () => {
    clearDnsCache();
    try {
        const addresses = dnsCache.resolveSync('localhost', 4);
        deepStrictEqual(addresses.map(address => address.family), addresses.map(() => 4));
        if (addresses.length === 0) throw new Error('localhost must resolve to an IPv4 address');
    } finally {
        clearDnsCache();
    }
});
