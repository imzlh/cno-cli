import { deepStrictEqual, ok, strictEqual } from 'node:assert';
import * as dns from 'node:dns';
import * as dnsp from 'node:dns/promises';

function joinBytes(...parts: Uint8Array[]): Uint8Array {
    const result = new Uint8Array(parts.reduce((size, part) => size + part.length, 0));
    let offset = 0;
    for (const part of parts) {
        result.set(part, offset);
        offset += part.length;
    }
    return result;
}

function u16(value: number): Uint8Array {
    const result = new Uint8Array(2);
    new DataView(result.buffer).setUint16(0, value);
    return result;
}

function u32(value: number): Uint8Array {
    const result = new Uint8Array(4);
    new DataView(result.buffer).setUint32(0, value);
    return result;
}

function dnsName(value: string): Uint8Array {
    const labels = value ? value.split('.') : [];
    const parts = labels.map(label => joinBytes(new Uint8Array([label.length]), new TextEncoder().encode(label)));
    return joinBytes(...parts, new Uint8Array([0]));
}

function answer(type: number, data: Uint8Array, ttl = 321): Uint8Array {
    return joinBytes(
        new Uint8Array([0xc0, 0x0c]), u16(type), u16(1), u32(ttl), u16(data.length), data,
    );
}

function ipv4(): Uint8Array {
    return new Uint8Array([203, 0, 113, 7]);
}

function ipv6(): Uint8Array {
    return new Uint8Array([0x20, 0x01, 0x0d, 0xb8, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 7]);
}

function txt(): Uint8Array {
    return joinBytes(new Uint8Array([5]), new TextEncoder().encode('hello'), new Uint8Array([5]), new TextEncoder().encode('world'));
}

function naptr(): Uint8Array {
    return joinBytes(u16(1), u16(2), new Uint8Array([1]), new TextEncoder().encode('U'), new Uint8Array([3]), new TextEncoder().encode('SIP'), new Uint8Array([0]), dnsName('replacement.fixture'));
}

function soa(): Uint8Array {
    return joinBytes(dnsName('ns.fixture'), dnsName('hostmaster.fixture'), u32(1), u32(2), u32(3), u32(4), u32(5));
}

function srv(): Uint8Array {
    return joinBytes(u16(1), u16(2), u16(443), dnsName('service.fixture'));
}

function caa(): Uint8Array {
    return joinBytes(new Uint8Array([128, 5]), new TextEncoder().encode('issue'), new TextEncoder().encode('ca.fixture'));
}

function readQuestion(packet: Uint8Array): { name: string; questionEnd: number; type: number } {
    const view = new DataView(packet.buffer, packet.byteOffset, packet.byteLength);
    let offset = 12;
    const labels: string[] = [];
    while (offset < packet.length && packet[offset] !== 0) {
        const length = packet[offset++];
        labels.push(new TextDecoder().decode(packet.slice(offset, offset + length)));
        offset += length;
    }
    offset++;
    const type = view.getUint16(offset);
    return { name: labels.join('.'), questionEnd: offset + 4, type };
}

function makeResponse(request: Uint8Array): Uint8Array {
    const question = readQuestion(request);
    const records: Uint8Array[] = [];
    if (question.name === 'slow.test') return new Uint8Array();
    let flags = 0x8180;
    if (question.name === 'missing.test') flags = 0x8183;
    else if (question.name === 'empty.test') flags = 0x8180;
    else if (question.name === 'malformed.test') records.push(answer(16, new Uint8Array([5, 65])));
    else if (question.type === 1) records.push(answer(1, ipv4(), question.name === 'high-ttl.test' ? 0xffffffff : 321));
    else if (question.type === 28) records.push(answer(28, ipv6()));
    else if (question.type === 5) records.push(answer(5, dnsName('alias.fixture')));
    else if (question.type === 2) records.push(answer(2, dnsName('ns.fixture')));
    else if (question.type === 12) records.push(answer(12, dnsName('ptr.fixture')));
    else if (question.type === 15) records.push(answer(15, joinBytes(u16(10), dnsName('mail.fixture'))));
    else if (question.type === 16) records.push(answer(16, txt()));
    else if (question.type === 6) records.push(answer(6, soa()));
    else if (question.type === 33) records.push(answer(33, srv()));
    else if (question.type === 35) records.push(answer(35, naptr()));
    else if (question.type === 257) records.push(answer(257, caa()));
    else if (question.type === 255) records.push(answer(1, ipv4()), answer(16, txt()), answer(257, caa()));

    const header = new Uint8Array(12);
    header.set(request.slice(0, 2), 0);
    const view = new DataView(header.buffer);
    view.setUint16(2, flags);
    view.setUint16(4, 1);
    view.setUint16(6, records.length);
    return joinBytes(header, request.slice(12, question.questionEnd), ...records);
}

function unavailable(error: unknown): boolean {
    const code = error && typeof error === 'object' ? Reflect.get(error, 'code') : undefined;
    const message = error instanceof Error ? error.message : String(error);
    return code === 'EPERM' || code === 'EACCES' || code === 'ENOSYS' || code === 'ENOTSUP'
        || message.includes('EPERM') || message.includes('EACCES');
}

interface FixtureServer {
    port: number;
    close: () => void;
    requestCount: () => number;
}

async function startServer(respond = true): Promise<FixtureServer> {
    const socket = Deno.listenDatagram({ transport: 'udp', hostname: '127.0.0.1', port: 0 });
    let running = true;
    let requests = 0;
    void (async () => {
        while (running) {
            try {
                const [request, remote] = await socket.receive();
                requests++;
                const response = makeResponse(request);
                if (respond && response.length > 0) await socket.send(response, remote);
            } catch {
                return;
            }
        }
    })();
    return {
        port: socket.addr.port,
        requestCount: () => requests,
        close: () => { running = false; socket.close(); },
    };
}

Deno.test({ name: 'dns Resolver uses its configured IPv4 port and shapes common records', timeout: 10000 }, async () => {
    let server: FixtureServer;
    try {
        server = await startServer();
    } catch (error) {
        if (unavailable(error)) return;
        throw error;
    }

    const previous = dns.getServers();
    try {
        const resolver = new dnsp.Resolver({ timeout: 500 });
        resolver.setServers([`127.0.0.1:${server.port}`]);
        strictEqual(resolver.getServers()[0], `127.0.0.1:${server.port}`);
        deepStrictEqual(dns.getServers(), previous);

        try {
            deepStrictEqual(await resolver.resolve4('fixture.test', { ttl: true }), [{ address: '203.0.113.7', ttl: 321 }]);
            deepStrictEqual(await resolver.resolve4('high-ttl.test', { ttl: true }), [{ address: '203.0.113.7', ttl: 0xffffffff }]);
            deepStrictEqual(await resolver.resolve6('fixture.test'), ['2001:db8::7']);
            deepStrictEqual(await resolver.resolveCname('fixture.test'), ['alias.fixture']);
            deepStrictEqual(await resolver.resolveMx('fixture.test'), [{ priority: 10, exchange: 'mail.fixture' }]);
            deepStrictEqual(await resolver.resolveNs('fixture.test'), ['ns.fixture']);
            deepStrictEqual(await resolver.resolveTxt('fixture.test'), [['hello', 'world']]);
            deepStrictEqual(await resolver.resolveCaa('fixture.test'), [{ critical: 128, issue: 'ca.fixture' }]);
            deepStrictEqual(await resolver.resolveAny('fixture.test'), [
                { type: 'A', address: '203.0.113.7', ttl: 321 },
                { type: 'TXT', entries: ['hello', 'world'] },
                { type: 'CAA', critical: 128, issue: 'ca.fixture' },
            ]);
            deepStrictEqual(await resolver.reverse('192.0.2.1'), ['ptr.fixture']);

            await resolver.resolve4('missing.test').then(
                () => { throw new Error('expected ENOTFOUND'); },
                error => {
                    strictEqual((error as NodeJS.ErrnoException).code, 'ENOTFOUND');
                    strictEqual((error as NodeJS.ErrnoException).syscall, 'queryA');
                },
            );
            await resolver.resolve4('empty.test').then(
                () => { throw new Error('expected ENODATA'); },
                error => strictEqual((error as NodeJS.ErrnoException).code, 'ENODATA'),
            );
            await resolver.resolveTxt('malformed.test').then(
                () => { throw new Error('expected EBADRESP'); },
                error => strictEqual((error as NodeJS.ErrnoException).code, 'EBADRESP'),
            );
        } catch (error) {
            if (unavailable(error)) return;
            throw error;
        }
    } finally {
        server.close();
        dns.setServers(previous);
    }
});

Deno.test({ name: 'dns Resolver cancel and timeout settle promises', timeout: 10000 }, async () => {
    let server: FixtureServer;
    try {
        server = await startServer();
    } catch (error) {
        if (unavailable(error)) return;
        throw error;
    }
    try {
        const resolver = new dnsp.Resolver({ timeout: 30 });
        resolver.setServers([`127.0.0.1:${server.port}`]);
        const cancelled = resolver.resolve4('slow.test');
        resolver.cancel();
        await cancelled.then(
            () => { throw new Error('expected ECANCELLED'); },
            error => strictEqual((error as NodeJS.ErrnoException).code, 'ECANCELLED'),
        );
        await resolver.resolve4('slow.test').then(
            () => { throw new Error('expected ETIMEOUT'); },
            error => strictEqual((error as NodeJS.ErrnoException).code, 'ETIMEOUT'),
        );
    } catch (error) {
        if (unavailable(error)) return;
        throw error;
    } finally {
        server.close();
    }
});

Deno.test('dns callback Resolver uses per-instance server', async () => {
    let server: FixtureServer;
    try {
        server = await startServer();
    } catch (error) {
        if (unavailable(error)) return;
        throw error;
    }
    try {
        const resolver = new dns.Resolver({ timeout: 500 });
        resolver.setServers([`127.0.0.1:${server.port}`]);
        const value = await new Promise<string[]>((resolve, reject) => {
            resolver.resolveCname('fixture.test', (error, names) => error ? reject(error) : resolve(names));
        });
        deepStrictEqual(value, ['alias.fixture']);
        await new Promise<void>((resolve, reject) => {
            resolver.resolve('fixture.test', undefined as unknown as 'A', (error, addresses) => {
                if (error) reject(error);
                else {
                    deepStrictEqual(addresses, ['203.0.113.7']);
                    resolve();
                }
            });
        });
    } catch (error) {
        if (unavailable(error)) return;
        throw error;
    } finally {
        server.close();
    }
});

Deno.test({ name: 'dns Resolver uses backup servers and configured tries', timeout: 10000 }, async () => {
    let silent: FixtureServer;
    let responding: FixtureServer;
    try {
        silent = await startServer(false);
        responding = await startServer();
    } catch (error) {
        if (unavailable(error)) return;
        throw error;
    }
    try {
        const failover = new dnsp.Resolver({ timeout: 20, tries: 1, maxTimeout: 20 });
        failover.setServers([
            `127.0.0.1:${silent.port}`,
            `127.0.0.1:${responding.port}`,
        ]);
        deepStrictEqual(await failover.resolve4('fixture.test'), ['203.0.113.7']);
        strictEqual(silent.requestCount(), 1);
        strictEqual(responding.requestCount(), 1);

        const retries = new dnsp.Resolver({ timeout: 10, tries: 2, maxTimeout: 10 });
        retries.setServers([`127.0.0.1:${silent.port}`]);
        await retries.resolve4('slow.test').then(
            () => { throw new Error('expected ETIMEOUT'); },
            error => strictEqual((error as NodeJS.ErrnoException).code, 'ETIMEOUT'),
        );
        strictEqual(silent.requestCount(), 3);
    } finally {
        silent.close();
        responding.close();
    }
});
