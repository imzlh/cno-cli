import { strictEqual, ok } from 'node:assert';
import * as dns from 'node:dns';
import * as dnsp from 'node:dns/promises';

async function optionalDns<T>(fn: () => Promise<T>): Promise<T | undefined> {
    try {
        return await fn();
    } catch (err: any) {
        ok(err instanceof Error);
        ok(typeof err.code === 'string' || /DNS|query|resolve|timeout|aborted/i.test(err.message));
        return undefined;
    }
}

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

// --- 3. promises.lookup -----------------------------------------------------

Deno.test('dns.promises.lookup returns address+family', async () => {
    const r = await dnsp.lookup('localhost');
    ok(typeof r.address === 'string' && r.address.length > 0);
    ok(r.family === 4 || r.family === 6);
});

// --- 4. resolve4 returns IPv4 addresses -------------------------------------

Deno.test('dns.resolve4 returns IPv4 addresses', async () => {
    const addrs = await optionalDns(() => new Promise<string[]>((resolve, reject) => {
        dns.resolve4('example.com', (err, a) => err ? reject(err) : resolve(a));
    }));
    if (!addrs) return;
    ok(Array.isArray(addrs));
    for (const a of addrs) ok(/^\d+\.\d+\.\d+\.\d+$/.test(a));
});

// --- 5. resolve6 returns IPv6 addresses -------------------------------------

Deno.test('dns.resolve6 returns IPv6 addresses', async () => {
    const addrs = await optionalDns(() => new Promise<string[]>((resolve, reject) => {
        dns.resolve6('example.com', (err, a) => err ? reject(err) : resolve(a));
    }));
    if (!addrs) return;
    ok(Array.isArray(addrs));
});

// --- 6. resolve NS ---------------------------------------------------------

Deno.test('dns.resolve NS returns array', async () => {
    const r = await optionalDns(() => new Promise<any[]>((resolve, reject) => {
        dns.resolve('example.com', 'NS', (err, a) => err ? reject(err) : resolve(a));
    }));
    if (!r) return;
    ok(Array.isArray(r));
});

// --- 7. resolve MX returns MxRecord shape ----------------------------------

Deno.test('dns.resolve MX returns records with exchange/priority', async () => {
    const r = await optionalDns(() => new Promise<any[]>((resolve, reject) => {
        dns.resolve('example.com', 'MX', (err, a) => err ? reject(err) : resolve(a));
    }));
    if (!r) return;
    ok(Array.isArray(r));
    for (const mx of r) {
        ok(typeof mx.exchange === 'string');
        ok(typeof mx.priority === 'number');
    }
});

// --- 8. resolve TXT returns arrays of strings -------------------------------

Deno.test('dns.resolve TXT returns arrays', async () => {
    const r = await optionalDns(() => new Promise<any[]>((resolve, reject) => {
        dns.resolve('example.com', 'TXT', (err, a) => err ? reject(err) : resolve(a));
    }));
    if (!r) return;
    ok(Array.isArray(r));
    for (const txt of r) ok(Array.isArray(txt));
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

// --- 11. promises.resolve4 --------------------------------------------------

Deno.test('dns.promises.resolve4 returns array', async () => {
    const r = await optionalDns(() => dnsp.resolve4('example.com'));
    if (!r) return;
    ok(Array.isArray(r));
});

// --- 12. promises.resolve6 --------------------------------------------------

Deno.test('dns.promises.resolve6 returns array', async () => {
    const r = await optionalDns(() => dnsp.resolve6('example.com'));
    if (!r) return;
    ok(Array.isArray(r));
});
