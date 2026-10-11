import { rejects, strictEqual } from 'node:assert';
import { ChannelClient } from '../../src/inspector/transport/channel-rpc.ts';
import { PipeClient } from '../../src/inspector/transport/pipe-rpc.ts';
import { WorkerEndpoint } from '../../src/inspector/transport/worker-endpoint.ts';
import { ChannelRecv } from '../../src/inspector/shared/native.ts';
import { WorkerEvent } from '../../src/inspector/shared/wire.ts';

class FakePipe {
    sent = 0;
    onmessage?: (message: unknown) => void;
    onmessageerror?: (error: Error) => void;
    onclose?: () => void;

    postMessage(): void { this.sent++; }
}

const delay = () => new Promise<void>((resolve) => setTimeout(resolve, 20));

Deno.test('inspector pipe close rejects pending and future calls and detaches listeners', async () => {
    const pipe = new FakePipe();
    const client = new PipeClient(pipe as unknown as CModuleWorker.MessagePipe);
    const pending = rejects(client.call('evaluate', {}), /pipe closed/);

    pipe.onclose!();
    await pending;
    await rejects(client.call('evaluate', {}), /pipe closed/);
    strictEqual(pipe.sent, 1);
    strictEqual(pipe.onmessage, undefined);
    strictEqual(pipe.onmessageerror, undefined);
    strictEqual(pipe.onclose, undefined);
    client.dispose();
});

Deno.test('inspector endpoint closes both transports when the pipe closes', async () => {
    const pipe = new FakePipe();
    const channel = { send: () => true, stop() {} } as unknown as CModuleDebug.DebugChannelWorker;
    const endpoint = new WorkerEndpoint(pipe as unknown as CModuleWorker.MessagePipe, channel);
    try {
        const running = rejects(endpoint.call('evaluate', { expression: '1' }), /pipe closed/);
        endpoint.setPaused(true);
        const paused = rejects(endpoint.call('evaluate', { expression: '2' }), /pipe closed/);
        pipe.onclose!();
        await Promise.all([running, paused]);
        await rejects(endpoint.call('requestPause', {}), /pipe closed/);
        await rejects(endpoint.call('evaluate', { expression: '3' }), /pipe closed/);
    } finally {
        endpoint.dispose();
    }
});

Deno.test('inspector channel dispose cancels polling and rejects requests', async () => {
    let polls = 0;
    let stops = 0;
    const channel = {
        send: () => true,
        waitRecv: () => { polls++; },
        recv: () => null,
        stop: () => { stops++; },
    } as unknown as CModuleDebug.DebugChannelWorker;
    const client = new ChannelClient(channel);
    const pending = rejects(client.send('evaluate', {}), /channel closed/);
    client.dispose();
    client.dispose();
    await pending;
    await rejects(client.send('evaluate', {}), /channel closed/);
    await delay();
    strictEqual(polls, 0);
    strictEqual(stops, 1);
});

Deno.test('inspector channel receive failure stops polling and settles requests', async () => {
    let polls = 0;
    const channel = {
        send: () => true,
        waitRecv: () => { polls++; },
        recv: () => { throw new Error('channel stopped'); },
        stop() {},
    } as unknown as CModuleDebug.DebugChannelWorker;
    const client = new ChannelClient(channel);
    try {
        await rejects(client.send('evaluate', {}), /channel closed/);
        await delay();
        strictEqual(polls, 1);
    } finally {
        client.dispose();
    }
});

Deno.test('inspector channel disposal during an event does not restart polling', async () => {
    let polls = 0;
    let received = false;
    const channel = {
        waitRecv: () => { polls++; },
        stop() {},
        recv: () => {
            if (received) return null;
            received = true;
            return { kind: ChannelRecv.Event, type: WorkerEvent.Resumed, payload: {} };
        },
    } as unknown as CModuleDebug.DebugChannelWorker;
    const client = new ChannelClient(channel);
    client.onEvent = () => client.dispose();
    try {
        await delay();
        strictEqual(received, true);
        strictEqual(polls, 1);
        strictEqual(client.onEvent, null);
    } finally {
        client.dispose();
    }
});
