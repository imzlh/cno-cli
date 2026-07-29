import { deepStrictEqual, strictEqual, throws } from 'node:assert';
import {
    h2Available,
    requireH2,
    type H2Header,
    type H2Session,
} from '@cnojs/http/h2-native';

function copyBytes(bytes: Uint8Array): Uint8Array {
    const copy = new Uint8Array(bytes.byteLength);
    copy.set(bytes);
    return copy;
}

function joinBytes(chunks: Uint8Array[]): Uint8Array {
    const joined = new Uint8Array(chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0));
    let offset = 0;
    for (const chunk of chunks) {
        joined.set(chunk, offset);
        offset += chunk.byteLength;
    }
    return joined;
}

function wirePair(client: H2Session, server: H2Session) {
    const toServer: Uint8Array[] = [];
    const toClient: Uint8Array[] = [];
    client.onsend = chunk => toServer.push(copyBytes(chunk));
    server.onsend = chunk => toClient.push(copyBytes(chunk));

    const drain = () => {
        for (let turn = 0; turn < 1000; turn++) {
            let progressed = false;
            while (toServer.length > 0) {
                progressed = true;
                server.receive(toServer.shift()!);
            }
            while (toClient.length > 0) {
                progressed = true;
                client.receive(toClient.shift()!);
            }
            if (!progressed) return;
        }
        throw new Error('HTTP/2 in-memory pump did not quiesce');
    };

    return { drain, toClient };
}

function requestHeaders(method = 'GET'): H2Header[] {
    return [
        [':method', method],
        [':path', '/'],
        [':scheme', 'http'],
        [':authority', 'localhost'],
    ];
}

Deno.test({
    name: 'native h2: flow-controlled DATA owns bytes until provider EOF',
    ignore: !h2Available(),
}, () => {
    const h2 = requireH2();
    const client = new h2.Session(false);
    const server = new h2.Session(true);
    const received: Uint8Array[] = [];
    let remoteEnded = false;

    const { drain } = wirePair(client, server);
    server.ondata = (_streamId, chunk, ended) => {
        received.push(copyBytes(chunk));
        remoteEnded ||= ended;
    };

    try {
        drain();
        const streamId = client.request(requestHeaders('POST'), false);
        const payload = new Uint8Array(256 * 1024);
        payload.fill(0x61);
        client.write(streamId, payload, true);
        payload.fill(0x62);
        drain();

        const body = new Uint8Array(received.reduce((sum, chunk) => sum + chunk.byteLength, 0));
        let offset = 0;
        for (const chunk of received) {
            body.set(chunk, offset);
            offset += chunk.byteLength;
        }
        strictEqual(body.byteLength, 256 * 1024);
        deepStrictEqual(body, new Uint8Array(body.byteLength).fill(0x61));
        strictEqual(remoteEnded, true);
    } finally {
        client.destroy();
        server.destroy();
    }
});

Deno.test({
    name: 'native h2: callback-triggered destroy is deferred until native frames unwind',
    ignore: !h2Available(),
}, () => {
    const h2 = requireH2();

    {
        const session = new h2.Session(false);
        let sends = 0;
        session.onsend = () => {
            sends++;
            session.destroy();
        };
        strictEqual(sends > 0, true);
        strictEqual(session.wantRead, undefined);
        session.destroy();
    }

    {
        const client = new h2.Session(false);
        const server = new h2.Session(true);
        const { drain } = wirePair(client, server);
        let frames = 0;
        server.onframe = () => {
            frames++;
            server.destroy();
        };
        try {
            drain();
            strictEqual(frames > 0, true);
        } finally {
            client.destroy();
            server.destroy();
        }
    }

    {
        const client = new h2.Session(false);
        const server = new h2.Session(true);
        const { drain } = wirePair(client, server);
        let streams = 0;
        server.onstream = () => {
            streams++;
            server.destroy();
        };
        try {
            drain();
            client.request(requestHeaders(), true);
            drain();
            strictEqual(streams, 1);
        } finally {
            client.destroy();
            server.destroy();
        }
    }

    {
        const client = new h2.Session(false);
        const server = new h2.Session(true);
        const { drain } = wirePair(client, server);
        let dataCallbacks = 0;
        server.ondata = () => {
            dataCallbacks++;
            server.destroy();
        };
        try {
            drain();
            const streamId = client.request(requestHeaders('POST'), false);
            client.write(streamId, new Uint8Array([1]), true);
            drain();
            strictEqual(dataCallbacks, 1);
        } finally {
            client.destroy();
            server.destroy();
        }
    }

    {
        const client = new h2.Session(false);
        const server = new h2.Session(true);
        const { drain } = wirePair(client, server);
        let closes = 0;
        server.onclose = () => {
            closes++;
            server.destroy();
        };
        try {
            drain();
            const streamId = client.request(requestHeaders(), false);
            drain();
            client.reset(streamId);
            drain();
            strictEqual(closes, 1);
        } finally {
            client.destroy();
            server.destroy();
        }
    }
});

Deno.test({
    name: 'native h2: respond and write inside onstream flush after receive unwinds',
    ignore: !h2Available(),
}, () => {
    const h2 = requireH2();
    const client = new h2.Session(false);
    const server = new h2.Session(true);
    const { drain, toClient } = wirePair(client, server);
    const received: Uint8Array[] = [];
    let callbackActive = false;
    let sendReentered = false;
    let ended = false;

    server.onsend = chunk => {
        if (callbackActive) sendReentered = true;
        toClient.push(copyBytes(chunk));
    };
    server.onstream = streamId => {
        callbackActive = true;
        server.respond(streamId, [[':status', '200']], false);
        server.write(streamId, new TextEncoder().encode('ok'), true);
        callbackActive = false;
    };
    client.ondata = (_streamId, chunk, endStream) => {
        received.push(copyBytes(chunk));
        ended ||= endStream;
    };
    client.onframe = (frameType, _streamId, flags) => {
        if (frameType === h2.constants.DATA && (flags & h2.constants.FLAG_END_STREAM)) ended = true;
    };

    try {
        drain();
        client.request(requestHeaders(), true);
        drain();
        strictEqual(sendReentered, false);
        strictEqual(ended, true);
        deepStrictEqual(received, [new Uint8Array([0x6f, 0x6b])]);
    } finally {
        client.destroy();
        server.destroy();
    }
});

Deno.test({
    name: 'native h2: queues flow-controlled consecutive DATA writes in order',
    ignore: !h2Available(),
}, () => {
    const h2 = requireH2();
    const client = new h2.Session(false);
    const server = new h2.Session(true);
    const { drain } = wirePair(client, server);
    const received: Uint8Array[] = [];
    const blocks = [
        new Uint8Array(128 * 1024).fill(0x61),
        new Uint8Array(128 * 1024).fill(0x62),
        new Uint8Array(128 * 1024).fill(0x63),
    ];
    let ended = false;

    server.ondata = (_streamId, chunk, endStream) => {
        received.push(copyBytes(chunk));
        ended ||= endStream;
    };
    server.onframe = (frameType, _streamId, flags) => {
        if (frameType === h2.constants.DATA && (flags & h2.constants.FLAG_END_STREAM)) ended = true;
    };

    try {
        drain();
        const streamId = client.request(requestHeaders('POST'), false);
        client.write(streamId, blocks[0], false);
        client.write(streamId, blocks[1], false);
        client.write(streamId, blocks[2], true);
        drain();

        deepStrictEqual(joinBytes(received), joinBytes(blocks));
        strictEqual(ended, true);
    } finally {
        client.destroy();
        server.destroy();
    }
});

Deno.test({
    name: 'native h2: rejects writes queued after END_STREAM synchronously',
    ignore: !h2Available(),
}, () => {
    const h2 = requireH2();
    const client = new h2.Session(false);
    const server = new h2.Session(true);
    const { drain } = wirePair(client, server);
    const received: Uint8Array[] = [];
    let streamCount = 0;
    const rejectionMessages: string[] = [];

    server.onstream = streamId => {
        if (streamCount++ === 0) {
            server.respond(streamId, [[':status', '200']], false);
            server.write(streamId, new Uint8Array([0x61]), true);
        } else {
            server.respond(streamId, [[':status', '204']], true);
        }
        try {
            server.write(streamId, new Uint8Array([0x62]), false);
        } catch (error) {
            rejectionMessages.push(String(error));
        }
    };
    client.ondata = (_streamId, chunk) => received.push(copyBytes(chunk));

    try {
        drain();
        client.request(requestHeaders(), true);
        client.request(requestHeaders(), true);
        drain();
        deepStrictEqual(received, [new Uint8Array([0x61])]);
        strictEqual(streamCount, 2);
        strictEqual(rejectionMessages.length, 2);
        strictEqual(rejectionMessages.every(message => /END_STREAM/i.test(message)), true);
    } finally {
        client.destroy();
        server.destroy();
    }
});

Deno.test({
    name: 'native h2: retires every queued DATA source after submit failure',
    ignore: !h2Available(),
}, () => {
    const h2 = requireH2();
    const client = new h2.Session(false);
    const server = new h2.Session(true);
    const { drain } = wirePair(client, server);
    let queued = false;

    server.onsettings = isAck => {
        if (isAck || queued) return;
        queued = true;
        server.write(0, new Uint8Array([0x61]), false);
        server.write(0, new Uint8Array([0x62]), true);
    };

    try {
        throws(() => drain());
        strictEqual(queued, true);
        server.flush();
    } finally {
        client.destroy();
        server.destroy();
    }
});

Deno.test({
    name: 'native h2: sends trailers after queued flow-controlled DATA',
    ignore: !h2Available(),
}, () => {
    const h2 = requireH2();
    const client = new h2.Session(false);
    const server = new h2.Session(true);
    const { drain } = wirePair(client, server);
    const received: Uint8Array[] = [];
    const blocks = [
        new Uint8Array(96 * 1024).fill(0x71),
        new Uint8Array(96 * 1024).fill(0x72),
    ];
    const receivedTrailers: H2Header[][] = [];
    let ended = false;
    let writeAfterTrailersRejected = false;

    server.onstream = streamId => {
        server.respond(streamId, [[':status', '200']], false);
        server.write(streamId, blocks[0], false);
        server.write(streamId, blocks[1], false);
        server.trailers(streamId, [['x-checksum', 'ok']]);
        try {
            server.write(streamId, new Uint8Array([0x73]), false);
        } catch (_error) {
            writeAfterTrailersRejected = true;
        }
    };
    client.ondata = (_streamId, chunk) => received.push(copyBytes(chunk));
    client.onheaders = (_streamId, headers, flags) => {
        receivedTrailers.push(headers);
        ended ||= Boolean(flags & h2.constants.FLAG_END_STREAM);
    };

    try {
        drain();
        client.request(requestHeaders(), true);
        drain();
        deepStrictEqual(joinBytes(received), joinBytes(blocks));
        deepStrictEqual(receivedTrailers, [[['x-checksum', 'ok']]]);
        strictEqual(ended, true);
        strictEqual(writeAfterTrailersRejected, true);
    } finally {
        client.destroy();
        server.destroy();
    }
});

Deno.test({
    name: 'native h2: queues consecutive DATA writes per stream',
    ignore: !h2Available(),
}, () => {
    const h2 = requireH2();
    const client = new h2.Session(false);
    const server = new h2.Session(true);
    const { drain } = wirePair(client, server);
    const received: Uint8Array[] = [];
    let ended = false;

    server.onstream = streamId => {
        server.respond(streamId, [[':status', '200']], false);
        server.write(streamId, new Uint8Array([0x61]), false);
        server.write(streamId, new Uint8Array([0x62]), false);
        server.write(streamId, new Uint8Array(0), true);
    };
    client.ondata = (_streamId, chunk, endStream) => {
        received.push(copyBytes(chunk));
        ended ||= endStream;
    };
    client.onframe = (frameType, _streamId, flags) => {
        if (frameType === h2.constants.DATA && (flags & h2.constants.FLAG_END_STREAM)) ended = true;
    };

    try {
        drain();
        client.request(requestHeaders(), true);
        drain();
        deepStrictEqual(received, [new Uint8Array([0x61]), new Uint8Array([0x62])]);
        strictEqual(ended, true);
    } finally {
        client.destroy();
        server.destroy();
    }
});

Deno.test({
    name: 'native h2: rejects malformed header lists without crashing',
    ignore: !h2Available(),
}, () => {
    const h2 = requireH2();
    const session = new h2.Session(false);
    session.onsend = () => {};
    try {
        throws(
            () => Reflect.apply(session.request, session, [{ ':method': 'GET' }, true]),
            /headers must be an array/i,
        );
        throws(
            () => Reflect.apply(session.request, session, [[[':method', 1]], true]),
            /names and values must be strings/i,
        );
        throws(
            () => Reflect.apply(session.request, session, [[['x-test', 'a\0b']], true]),
            /must not contain NUL/i,
        );
    } finally {
        session.destroy();
    }
});
