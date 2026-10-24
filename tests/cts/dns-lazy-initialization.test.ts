import { doesNotMatch, strictEqual } from 'node:assert';
import { decodeUtf8 } from '../_helpers/bytes.ts';

async function runProbe(source: string): Promise<void> {
    const child = new Deno.Command(Deno.execPath(), {
        args: ['eval', '--ext=js', source],
        stdout: 'piped', stderr: 'piped',
    }).spawn();
    const timer = setTimeout(() => child.kill(), 20000);
    try {
        const result = await child.output();
        strictEqual(result.code, 0, decodeUtf8(result.stdout) + decodeUtf8(result.stderr));
        doesNotMatch(decodeUtf8(result.stderr), /Memory leak:|Assertion .* failed/i);
    } finally {
        clearTimeout(timer);
    }
}

Deno.test({ name: 'DNS defaults are not read by bootstrap, imports, lookup or explicit resolvers', timeout: 30000 }, () => runProbe(`
    const nativeDns = import.meta.use('dns');
    const descriptor = Object.getOwnPropertyDescriptor(nativeDns, '__default_dnssrv');
    if (typeof descriptor?.get !== 'function') throw new Error('DNS defaults must be lazy');
    let discoveries = 0;
    Object.defineProperty(nativeDns, '__default_dnssrv', {
        get() { discoveries++; return ['192.0.2.53']; }, configurable: true,
    });
    const dns = await import('node:dns');
    const dnsp = await import('node:dns/promises');
    const resolver = new dns.Resolver();
    const promiseResolver = new dnsp.Resolver();
    resolver.setServers(['127.0.0.1']);
    promiseResolver.setServers(['127.0.0.2']);
    dns.setServers(['127.0.0.3']);
    if (resolver.getServers()[0] !== '127.0.0.1' ||
        promiseResolver.getServers()[0] !== '127.0.0.2' ||
        dnsp.getServers()[0] !== '127.0.0.3') throw new Error('Explicit DNS settings were lost');
    await dnsp.lookup('localhost');
    await Deno.resolveDns('localhost', 'A');
    await Deno.resolveDns('localhost', 'AAAA');
    nativeDns.query = async () => [];
    await Deno.resolveDns('fixture.test', 'TXT', { nameServer: { ipAddr: '127.0.0.1' } });
    if (discoveries !== 0) throw new Error('Unnecessary DNS settings discovery: ' + discoveries);
    console.log('Hello world');
`));

Deno.test({ name: 'DNS defaults are discovered on demand, cached and preserved per resolver', timeout: 30000 }, () => runProbe(`
    const nativeDns = import.meta.use('dns');
    let discoveries = 0;
    Object.defineProperty(nativeDns, '__default_dnssrv', {
        get() { discoveries++; return ['192.0.2.53']; }, configurable: true,
    });
    const dns = await import('node:dns');
    const resolver = new dns.Resolver();
    dns.setServers(['127.0.0.1']);
    if (discoveries !== 0) throw new Error('Resolver construction discovered system DNS');
    if (resolver.getServers()[0] !== '192.0.2.53') throw new Error('Resolver lost its system defaults');
    resolver.getServers();
    if (discoveries !== 1) throw new Error('Resolver failed to cache system DNS');
    const inherited = new dns.Resolver();
    dns.setServers(['127.0.0.2']);
    if (inherited.getServers()[0] !== '127.0.0.1') throw new Error('Resolver lost its explicit defaults');
`));

Deno.test({ name: 'Deno raw DNS discovers system settings only on the first default query', timeout: 30000 }, () => runProbe(`
    const win32 = import.meta.use('win32');
    const fs = import.meta.use('fs');
    const nativeDns = import.meta.use('dns');
    let reads = 0;
    if (win32) {
        win32.readRegistry = () => { reads++; return '192.0.2.53'; };
    } else {
        fs.readFile = () => { reads++; return new TextEncoder().encode('nameserver 192.0.2.53'); };
    }
    nativeDns.query = async (query, type, server) => {
        if (server !== '192.0.2.53') throw new Error('System DNS was not passed to the query');
        return [];
    };
    if (reads !== 0) throw new Error('DNS settings were read during bootstrap');
    await Deno.resolveDns('fixture.test', 'TXT');
    await Deno.resolveDns('fixture.test', 'TXT');
    if (reads !== 1) throw new Error('System DNS should be read once on demand: ' + reads);
`));
