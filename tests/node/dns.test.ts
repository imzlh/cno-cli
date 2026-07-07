import { ok, rejects, strictEqual, throws } from 'node:assert';
import * as dns from 'node:dns';
import * as dnsp from 'node:dns/promises';

// --- 1. lookup localhost returns loopback ------------------------------------

Deno.test('dns: lookup localhost returns loopback', async () => {
    const r = await new Promise<{ address: string; family: number }>((resolve, reject) => {
        dns.lookup('localhost', (err, address, family) => {
            if (err) reject(err); else resolve({ address, family });
        });
    });
    ok(r.address === '127.0.0.1' || r.address === '::1', `expected loopback, got ${r.address}`);
    ok(r.family === 4 || r.family === 6);
});

// --- 2. lookupSync returns address ------------------------------------------

Deno.test('dns: lookupSync localhost returns loopback', () => {
    const r = dns.lookupSync('localhost');
    ok(typeof r === 'string' || Array.isArray(r));
});

Deno.test('dns: lookupSync localhost with all=true returns address objects', () => {
    const entries = dns.lookupSync('localhost', { all: true });
    ok(Array.isArray(entries));
    ok(entries.length > 0);
    ok(typeof entries[0]!.address === 'string');
    ok(entries[0]!.family === 4 || entries[0]!.family === 6);
});

// --- 3. promises.lookup -----------------------------------------------------

Deno.test('dns.promises.lookup returns address+family', async () => {
    const r = await dnsp.lookup('localhost');
    ok(typeof r.address === 'string' && r.address.length > 0);
    ok(r.family === 4 || r.family === 6);
});

// --- 4. lookup localhost with all=true returns address objects --------------

Deno.test('dns: lookup localhost with all=true returns address objects', async () => {
    const entries = await new Promise<Array<{ address: string; family: number }>>((resolve, reject) => {
        dns.lookup('localhost', { all: true }, (err, addresses) => {
            if (err) reject(err);
            else resolve(addresses);
        });
    });
    ok(Array.isArray(entries));
    ok(entries.length > 0);
    ok(typeof entries[0]!.address === 'string');
    ok(entries[0]!.family === 4 || entries[0]!.family === 6);
});

// --- 5. getServers / setServers round-trip ---------------------------------

Deno.test('dns: getServers and setServers round-trip loopback server list', () => {
    const previous = dns.getServers();
    try {
        ok(Array.isArray(previous));
        dns.setServers(['127.0.0.1']);
        strictEqual(dns.getServers().join(','), '127.0.0.1');
    } finally {
        dns.setServers(previous);
    }
});

// --- 6. Resolver setServers/getServers -------------------------------------

Deno.test('dns: Resolver getServers reflects setServers', () => {
    const resolver = new dns.Resolver();
    resolver.setServers(['127.0.0.1']);
    strictEqual(resolver.getServers().join(','), '127.0.0.1');
});

// --- 7. promises Resolver setServers/getServers -----------------------------

Deno.test('dns.promises: Resolver getServers reflects setServers', () => {
    const resolver = new dnsp.Resolver();
    resolver.setServers(['127.0.0.1']);
    strictEqual(resolver.getServers().join(','), '127.0.0.1');
});

Deno.test('dns.promises: getServers and setServers mirror callback API state', () => {
    const previous = dns.getServers();
    try {
        dnsp.setServers(['127.0.0.1']);
        strictEqual(dnsp.getServers().join(','), '127.0.0.1');
        strictEqual(dns.getServers().join(','), '127.0.0.1');
    } finally {
        dns.setServers(previous);
    }
});

Deno.test('dns: lookup accepts numeric family and rejects invalid family', async () => {
    const ipv4 = await new Promise<{ address: string; family: number }>((resolve, reject) => {
        dns.lookup('127.0.0.1', 4, (err, address, family) => {
            if (err) reject(err);
            else resolve({ address, family });
        });
    });
    strictEqual(ipv4.address, '127.0.0.1');
    strictEqual(ipv4.family, 4);

    const ipv6 = await dnsp.lookup('::1', 6);
    strictEqual(Array.isArray(ipv6), false);
    strictEqual((ipv6 as { address: string; family: number }).address, '::1');
    strictEqual((ipv6 as { address: string; family: number }).family, 6);

    throws(() => dns.lookup('localhost', 5, () => {}), TypeError);
    throws(() => dns.lookup('localhost', true as unknown as dns.LookupOptions, () => {}), TypeError);
    throws(() => dns.lookupSync('localhost', { family: 5 }), TypeError);
    throws(() => dnsp.lookup('localhost', 5), TypeError);
});

Deno.test('dns: lookup accepts IPv4 and IPv6 string family values', async () => {
    const ipv4 = await dnsp.lookup('127.0.0.1', { family: 'IPv4' });
    strictEqual(Array.isArray(ipv4), false);
    strictEqual((ipv4 as { address: string; family: number }).address, '127.0.0.1');
    strictEqual((ipv4 as { address: string; family: number }).family, 4);

    const ipv6 = await new Promise<{ address: string; family: number }>((resolve, reject) => {
        dns.lookup('::1', { family: 'IPv6' }, (err, address, family) => {
            if (err) reject(err);
            else resolve({ address, family });
        });
    });
    strictEqual(ipv6.address, '::1');
    strictEqual(ipv6.family, 6);
});

Deno.test('dns: rejects invalid rrtype instead of silently querying A', async () => {
    throws(() => dns.resolve('localhost', 'BAD' as 'A', () => {}), TypeError);
    await rejects(() => dnsp.resolve('localhost', 'BAD'), TypeError);
});

Deno.test('dns: validates servers and supports ipv6first result order', () => {
    const previousServers = dns.getServers();
    const previousOrder = dns.getDefaultResultOrder();
    try {
        throws(() => dns.setServers('127.0.0.1' as unknown as string[]), TypeError);
        throws(() => dns.setServers([1 as unknown as string]), TypeError);
        throws(() => dns.setServers(['bad host']), TypeError);
        throws(() => dns.setServers(['127.0.0.1:abc']), TypeError);
        dns.setServers(['127.0.0.1:53', '[::1]:53']);
        strictEqual(dns.getServers().join(','), '127.0.0.1,[::1]:53');

        const resolver = new dns.Resolver();
        throws(() => resolver.setServers(['bad host']), TypeError);

        dns.setDefaultResultOrder('ipv6first');
        strictEqual(dns.getDefaultResultOrder(), 'ipv6first');
        dnsp.setDefaultResultOrder('verbatim');
        strictEqual(dnsp.getDefaultResultOrder(), 'verbatim');
        throws(() => dns.setDefaultResultOrder('bad' as 'verbatim'), TypeError);
    } finally {
        dns.setServers(previousServers);
        dns.setDefaultResultOrder(previousOrder);
    }
});

// --- 8. lookupService uses local service database ---------------------------

Deno.test('dns: lookupService resolves service name for local address', async () => {
    const result = await new Promise<{ host: string; service: string }>((resolve, reject) => {
        dns.lookupService('127.0.0.1', 80, (err, host, service) => {
            if (err) reject(err);
            else resolve({ host, service });
        });
    });
    ok(typeof result.host === 'string' && result.host.length > 0);
    strictEqual(result.service, 'http');
});

Deno.test('dns upstream: lookupService promise APIs and not-found errors match callback API', async () => {
    const promiseResult = await dnsp.lookupService('127.0.0.1', 80);
    strictEqual(typeof promiseResult.hostname, 'string');
    strictEqual(promiseResult.service, 'http');

    let promiseError: NodeJS.ErrnoException | null = null;
    try {
        await dnsp.lookupService('10.0.0.0', 80);
    } catch (error) {
        promiseError = error as NodeJS.ErrnoException;
    }
    strictEqual(promiseError?.message, 'getnameinfo ENOTFOUND 10.0.0.0');
    strictEqual(promiseError?.code, 'ENOTFOUND');
    strictEqual(promiseError?.syscall, 'getnameinfo');

    const callbackError = await new Promise<NodeJS.ErrnoException | null>((resolve) => {
        dns.lookupService('10.0.0.0', 80, (err) => resolve(err));
    });
    strictEqual(callbackError?.message, 'getnameinfo ENOTFOUND 10.0.0.0');
    strictEqual(callbackError?.code, 'ENOTFOUND');
    strictEqual(callbackError?.syscall, 'getnameinfo');
});

// --- 9. reverse on a known IP -----------------------------------------------

Deno.test('dns.reverse on 127.0.0.1 returns hostnames', async () => {
    const r = await new Promise<string[]>((resolve, reject) => {
        dns.reverse('127.0.0.1', (err, a) => err ? reject(err) : resolve(a));
    });
    ok(Array.isArray(r) && r.length >= 0);
});

// --- 10. error codes are exposed --------------------------------------------

Deno.test('dns error codes are defined', () => {
    for (const k of ['NODATA', 'FORMERR', 'SERVFAIL', 'NOTFOUND', 'NOTIMP', 'REFUSED']) {
        ok(typeof (dns as typeof dns & Record<string, string>)[k] === 'string');
    }
});

// --- 11. default result order get/set round-trip ---------------------------

Deno.test('dns: getDefaultResultOrder and setDefaultResultOrder round-trip', () => {
    const previous = dns.getDefaultResultOrder();
    const next = previous === 'verbatim' ? 'ipv4first' : 'verbatim';
    try {
        dns.setDefaultResultOrder(next);
        strictEqual(dns.getDefaultResultOrder(), next);
    } finally {
        dns.setDefaultResultOrder(previous);
    }
});
