import { strictEqual, throws } from 'node:assert';
import { createSocket, type Socket } from 'node:dgram';

async function bind(socket: Socket, address: string): Promise<void> {
    await new Promise<void>((resolve, reject) => {
        socket.once('error', reject);
        socket.bind(0, address, resolve);
    });
}

async function exchange(receiver: Socket, send: (callback: (error: Error | null, bytes: number) => void) => void): Promise<void> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
        const message = new Promise<string>((resolve, reject) => {
            receiver.once('message', data => resolve(data.toString()));
            receiver.once('error', reject);
        });
        const sent = new Promise<number>((resolve, reject) => {
            send((error, bytes) => error ? reject(error) : resolve(bytes));
        });
        const result = await Promise.race([
            Promise.all([message, sent]),
            new Promise<never>((_, reject) => {
                timer = setTimeout(() => reject(new Error('send callback or datagram did not arrive')), 3000);
            }),
        ]);
        strictEqual(result[0], 'xy');
        strictEqual(result[1], 2);
    } finally {
        clearTimeout(timer);
    }
}

Deno.test('dgram: connected offset/length sends invoke their callback', async () => {
    const receiver = createSocket('udp4');
    const sender = createSocket('udp4');
    try {
        await bind(receiver, '127.0.0.1');
        await new Promise<void>((resolve, reject) => {
            sender.once('error', reject);
            sender.connect(receiver.address().port, '127.0.0.1', resolve);
        });
        await exchange(receiver, callback => sender.send(Buffer.from('xyz'), 0, 2, callback));
    } finally {
        sender.close();
        receiver.close();
    }
});

Deno.test('dgram: udp6 defaults to the IPv6 loopback address', async () => {
    const receiver = createSocket('udp6');
    const sender = createSocket('udp6');
    try {
        try {
            await bind(receiver, '::1');
        } catch (error) {
            if (['EAFNOSUPPORT', 'EADDRNOTAVAIL', 'EPROTONOSUPPORT'].includes((error as { code: string }).code)) return;
            throw error;
        }
        await exchange(receiver, callback => sender.send('xy', receiver.address().port, callback));
    } finally {
        sender.close();
        receiver.close();
    }
});

Deno.test('dgram: send validates addresses and rejects closed sockets synchronously', () => {
    const sender = createSocket('udp4');
    try {
        throws(() => sender.send('x', 12345, 42 as unknown as string), { code: 'ERR_INVALID_ARG_TYPE' });
    } finally {
        sender.close();
    }
    throws(() => sender.send('x', 12345, '127.0.0.1'), { code: 'ERR_SOCKET_DGRAM_NOT_RUNNING' });
});
