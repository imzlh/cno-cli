import { deepStrictEqual, ok, rejects, strictEqual } from 'node:assert';

const ssl = import.meta.use('ssl');

export async function within<T>(promise: Promise<T>, label: string, timeout = 30000): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
        return await Promise.race([
            promise,
            new Promise<never>((_, reject) => {
                timer = setTimeout(() => reject(new Error(`${label} timed out`)), timeout);
            }),
        ]);
    } finally {
        if (timer !== undefined) clearTimeout(timer);
    }
}

export async function readQuicStream(stream: ReadableStream<Uint8Array<ArrayBuffer>>): Promise<Uint8Array> {
    const reader = stream.getReader();
    const chunks: Uint8Array[] = [];
    let length = 0;
    try {
        for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            chunks.push(value);
            length += value.byteLength;
        }
    } finally {
        reader.releaseLock();
    }
    const bytes = new Uint8Array(length);
    let offset = 0;
    for (const chunk of chunks) {
        bytes.set(chunk, offset);
        offset += chunk.byteLength;
    }
    return bytes;
}

export async function quicRoundTrip(hostname = '127.0.0.1', useImplicitClient = false): Promise<void> {
    const { cert, key } = ssl.createSelfSignedCert({ commonName: 'localhost', days: 1 });
    const serverEndpoint = new Deno.QuicEndpoint({ hostname, port: 0 });
    const clientEndpoint = useImplicitClient ? undefined : new Deno.QuicEndpoint({ hostname, port: 0 });
    let activeClientEndpoint = clientEndpoint;
    try {
        const listener = serverEndpoint.listen({
            cert, key, alpnProtocols: ['server-only', 'cno-protocol-test', 'fallback'],
        });
        ok(serverEndpoint.addr.port > 0, 'server exposes its bound ephemeral port');
        const [server, client] = await within(Promise.all([
            listener.accept(),
            Deno.connectQuic({
                hostname, port: serverEndpoint.addr.port,
                serverName: 'localhost', caCerts: [cert],
                alpnProtocols: ['client-only', 'fallback', 'cno-protocol-test'], endpoint: clientEndpoint,
            }).then(connection => {
                activeClientEndpoint = connection.endpoint;
                return connection;
            }),
        ]), 'QUIC verified handshake');
        strictEqual(client.protocol, 'cno-protocol-test');
        strictEqual(server.protocol, 'cno-protocol-test');
        strictEqual(server.serverName, 'localhost');
        ok(client.endpoint.addr.port > 0, 'client exposes its bound ephemeral port');
        strictEqual(server.remoteAddr.hostname, hostname);
        strictEqual(server.remoteAddr.port, client.endpoint.addr.port);
        strictEqual(client.remoteAddr.port, serverEndpoint.addr.port);

        const payload = Uint8Array.from({ length: 256 * 1024 }, (_, index) => index % 251);
        const incomingReader = server.incomingBidirectionalStreams.getReader();
        const acceptingStream = incomingReader.read();
        const outgoing = await client.createBidirectionalStream();
        const writer = outgoing.writable.getWriter();
        const sent = writer.write(payload).then(() => writer.close());
        const { value: incoming, done } = await within(acceptingStream, 'QUIC incoming bidi stream');
        ok(!done && incoming);
        incomingReader.releaseLock();
        const echo = incoming.readable.pipeTo(incoming.writable);
        const [, , received] = await within(Promise.all([
            sent, echo, readQuicStream(outgoing.readable),
        ]), 'QUIC bidirectional echo');
        writer.releaseLock();
        deepStrictEqual(received, payload);

        const uniReader = client.incomingUnidirectionalStreams.getReader();
        const receivingUni = uniReader.read();
        const uni = await server.createUnidirectionalStream();
        const uniWriter = uni.getWriter();
        const uniPayload = new Uint8Array([0, 255, 127, 3]);
        await uniWriter.write(uniPayload);
        await uniWriter.close();
        uniWriter.releaseLock();
        const { value: uniStream, done: uniDone } = await within(receivingUni, 'QUIC incoming uni stream');
        ok(!uniDone && uniStream);
        uniReader.releaseLock();
        deepStrictEqual(await within(readQuicStream(uniStream), 'QUIC unidirectional receive'), uniPayload);

        const resetIncomingReader = server.incomingUnidirectionalStreams.getReader();
        const resetIncoming = resetIncomingReader.read();
        const resetStream = await client.createUnidirectionalStream();
        const resetWriter = resetStream.getWriter();
        const resetWriterClosed = resetWriter.closed.catch(() => {});
        await resetWriter.write(new Uint8Array([1]));
        const { value: resetReceive, done: resetDone } = await within(resetIncoming, 'QUIC reset stream open');
        ok(!resetDone && resetReceive);
        resetIncomingReader.releaseLock();
        const resetReader = resetReceive.getReader();
        deepStrictEqual((await within(resetReader.read(), 'QUIC data before reset')).value, new Uint8Array([1]));
        const resetRejected = rejects(resetReader.read(), /QUIC stream reset \(23\)/);
        await resetWriter.abort(23);
        await within(resetRejected, 'QUIC peer RESET_STREAM');
        await resetWriterClosed;
        resetReader.releaseLock();
        resetWriter.releaseLock();

        const stopIncomingReader = server.incomingBidirectionalStreams.getReader();
        const stopIncoming = stopIncomingReader.read();
        const stopStream = await client.createBidirectionalStream();
        const stopWriter = stopStream.writable.getWriter();
        await stopWriter.write(new Uint8Array([2]));
        const { value: stopReceive, done: stopDone } = await within(stopIncoming, 'QUIC stopped stream open');
        ok(!stopDone && stopReceive);
        stopIncomingReader.releaseLock();
        const stopReader = stopReceive.readable.getReader();
        deepStrictEqual((await within(stopReader.read(), 'QUIC data before stop')).value, new Uint8Array([2]));
        const stopRejected = rejects(stopWriter.closed, /QUIC stream stopped \(57\)/);
        await stopReader.cancel(57);
        await within(stopRejected, 'QUIC peer STOP_SENDING');
        stopReader.releaseLock();
        stopWriter.releaseLock();
        const reverseWriter = stopReceive.writable.getWriter();
        await reverseWriter.write(uniPayload);
        await reverseWriter.close();
        reverseWriter.releaseLock();
        deepStrictEqual(await within(readQuicStream(stopStream.readable), 'QUIC surviving stream direction'), uniPayload);

        const canceledIncomingReader = server.incomingUnidirectionalStreams.getReader();
        const canceledIncoming = canceledIncomingReader.read();
        const canceledSend = await client.createUnidirectionalStream();
        const canceledWriter = canceledSend.getWriter();
        const canceledWriterClosed = canceledWriter.closed.catch(() => {});
        await canceledWriter.write(new Uint8Array([3]));
        const { value: canceledReceive, done: canceledDone } = await within(canceledIncoming, 'QUIC canceled uni stream open');
        ok(!canceledDone && canceledReceive);
        const canceledReader = canceledReceive.getReader();
        strictEqual((await within(canceledReader.read(), 'QUIC data before cancel')).value?.[0], 3);
        await canceledReader.cancel(31);
        const nextIncoming = canceledIncomingReader.read();
        const inFlightWrites = Array.from({ length: 16 }, () => canceledWriter.write(new Uint8Array(1024)));
        await Promise.allSettled(inFlightWrites);
        const nextSend = await client.createUnidirectionalStream();
        const nextWriter = nextSend.getWriter();
        await nextWriter.write(uniPayload);
        await nextWriter.close();
        nextWriter.releaseLock();
        const { value: nextReceive, done: nextDone } = await within(nextIncoming, 'QUIC next uni stream after cancel');
        ok(!nextDone && nextReceive);
        strictEqual(nextReceive.id, nextSend.id, 'late data must not recreate a canceled stream');
        deepStrictEqual(await within(readQuicStream(nextReceive), 'QUIC receive after canceled stream'), uniPayload);
        await within(canceledWriterClosed, 'QUIC canceled writer release');
        canceledReader.releaseLock();
        canceledWriter.releaseLock();
        canceledIncomingReader.releaseLock();

        const datagram = new Uint8Array([4, 2, 0, 9]);
        const serverDatagram = server.readDatagram();
        await client.sendDatagram(datagram);
        deepStrictEqual(await within(serverDatagram, 'QUIC client datagram'), datagram);
        const clientDatagram = client.readDatagram();
        await server.sendDatagram(datagram);
        deepStrictEqual(await within(clientDatagram, 'QUIC server datagram'), datagram);

        const peerClosed = server.closed;
        client.close({ closeCode: 42, reason: 'round trip complete' });
        deepStrictEqual(await within(client.closed, 'QUIC local close'), {
            closeCode: 42, reason: 'round trip complete',
        });
        deepStrictEqual(await within(peerClosed, 'QUIC peer close'), {
            closeCode: 42, reason: 'round trip complete',
        });
    } finally {
        activeClientEndpoint?.close();
        serverEndpoint.close();
    }
}

export async function quicConcurrentConnections(): Promise<void> {
    const { cert, key } = ssl.createSelfSignedCert({ commonName: 'localhost', days: 1 });
    const serverEndpoint = new Deno.QuicEndpoint({ hostname: '127.0.0.1', port: 0 });
    const clientEndpoint = new Deno.QuicEndpoint({ hostname: '127.0.0.1', port: 0 });
    try {
        const listener = serverEndpoint.listen({ cert, key, alpnProtocols: ['cno-quic'] });
        const connections: [Deno.QuicConn, Deno.QuicConn][] = [];
        for (let index = 0; index < 3; index++) {
            connections.push(await within(Promise.all([
                listener.accept(),
                Deno.connectQuic({
                    endpoint: clientEndpoint,
                    hostname: '127.0.0.1', port: serverEndpoint.addr.port,
                    serverName: 'localhost', alpnProtocols: ['cno-quic'],
                    ...(index === 0 ? { caCerts: [cert] } : {}),
                }),
            ]), `concurrent QUIC connection ${index}`, 10000));
        }
        await within(Promise.all(connections.map(async ([server, client], index) => {
            strictEqual(server.remoteAddr.port, clientEndpoint.addr.port);
            const incomingReader = server.incomingBidirectionalStreams.getReader();
            const receiving = incomingReader.read();
            const outgoing = await client.createBidirectionalStream();
            const writer = outgoing.writable.getWriter();
            const payload = new Uint8Array(128 * 1024).fill(index + 1);
            const sending = writer.write(payload).then(() => writer.close());
            const { value: incoming, done } = await receiving;
            ok(!done && incoming);
            incomingReader.releaseLock();
            const [, , echoed] = await Promise.all([
                sending, incoming.readable.pipeTo(incoming.writable), readQuicStream(outgoing.readable),
            ]);
            deepStrictEqual(echoed, payload);
            writer.releaseLock();
        })), 'isolated concurrent QUIC streams', 10000);
        for (const [server, client] of connections) {
            client.close();
            await within(Promise.all([client.closed, server.closed]), 'concurrent connection shutdown', 5000);
        }
    } finally {
        clientEndpoint.close();
        serverEndpoint.close();
    }
}
