/**
 * Native nghttp2 flow-control surface.
 *
 * COVERAGE WARNING — the nine flow-control tests below are gated
 * `ignore: !h2Available()`, and `h2Available()` is false in this binary for a
 * BUILD reason, not a platform one: `build/CMakeCache.txt` carries
 * `CNO_EMBED_EXT_H2:BOOL=OFF`, so the native nghttp2 extension was never
 * compiled in. (OBSERVED 2026-08-04: 0 ok / 9 skipped.)
 *
 * That matters because sibling files DO exercise the JS-side h2 path against the
 * real H2Stream class and pass (tests/webapi/h2-body-cap.test.ts 12 ok,
 * tests/webapi/h2-truncation.test.ts 15 ok). So a green verdict here would imply
 * native-flow coverage that does not exist. Re-enable by building with
 * -DCNO_EMBED_EXT_H2=ON; until then treat native H2 flow control as UNMEASURED.
 *
 * This file used to report a file-level PASS while executing ZERO tests, which is
 * worse than failing. The two GATE tests at the bottom therefore run
 * unconditionally and assert the fail-closed contract, so the file always
 * executes at least one real assertion in either build configuration. Same shape
 * as tests/webapi/quic-native.test.ts — do not add `ignore:` to them.
 */
import { deepStrictEqual, ok, strictEqual, throws } from 'node:assert';
import {
    h2Available,
    requireH2,
    tryLoadH2,
    __forceH2Unavailable,
    type H2Header,
    type H2Session,
} from '@cnojs/http/h2-native';
import { h2 } from '@cnojs/http/h2';

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

/* ── GATE: these two run in EVERY build configuration ──────────────────────
 * Without them this file reported PASS while executing zero tests whenever
 * CNO_EMBED_EXT_H2=OFF. They assert the fail-closed contract rather than the
 * native behaviour, so they are meaningful with or without the extension.
 * Never add an `ignore:` to them. */

Deno.test({
    name: 'native h2 GATE: the load gate is self-consistent and names its build flag',
}, () => {
    // h2Available() must never disagree with tryLoadH2().
    strictEqual(h2Available(), tryLoadH2() !== null);
    if (h2Available()) {
        const mod = requireH2();
        ok(typeof mod.Session === 'function', 'Session ctor');
        ok(mod.constants !== null && typeof mod.constants === 'object', 'constants');
        strictEqual(tryLoadH2(), mod, 'tryLoadH2 is cached/stable');
    } else {
        // The error must be actionable: it has to name the build flag, or nobody
        // reading a CI log can tell a missing extension from a broken one.
        let msg = '';
        try {
            requireH2();
            ok(false, 'expected requireH2() to throw when h2 is unavailable');
        } catch (e) {
            msg = e instanceof Error ? e.message : String(e);
        }
        ok(/CNO_EMBED_EXT_H2/.test(msg), `message must name the build flag, got: ${msg}`);
        ok(/HTTP\/2/i.test(msg), msg);
    }
});

Deno.test({
    name: 'native h2 GATE: h2 protocol module fails closed, it does not silently no-op',
}, async () => {
    // __forceH2Unavailable drives the same path as CNO_EMBED_EXT_H2=OFF, so this
    // half of the contract is measured even on a build that HAS the extension.
    __forceH2Unavailable(true);
    try {
        strictEqual(h2Available(), false);
        strictEqual(tryLoadH2(), null);

        // Both protocol entry points must reject. A resolved promise here would
        // mean an h2 connection object built on a missing native.
        for (const [label, run] of [
            ['server.accept', () => h2.server.accept(null as never, { secure: true } as never)],
            ['client.connect', () => h2.client.connect(null as never, { secure: true } as never)],
        ] as const) {
            let rejected = false;
            let msg = '';
            try {
                await run();
            } catch (e) {
                rejected = true;
                msg = e instanceof Error ? e.message : String(e);
            }
            ok(rejected, `${label} must reject when the native is absent`);
            ok(/CNO_EMBED_EXT_H2/.test(msg), `${label}: ${msg}`);
        }

        // requireH2 reached through the protocol module must be the same gate.
        throws(() => h2.requireH2(), /CNO_EMBED_EXT_H2/);
    } finally {
        __forceH2Unavailable(false);
    }
    // The force flag must be reversible: a leaked `true` would silently disable
    // h2 for every test file that runs after this one in the same process.
    strictEqual(h2Available(), tryLoadH2() !== null);
});
