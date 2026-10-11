import { strictEqual } from 'node:assert';

for (const operation of ['cancel', 'abort'] as const) {
    Deno.test(`deno net: ${operation} releases the connection`, async () => {
        const listener = Deno.listen({ hostname: '127.0.0.1', port: 0 });
        let client: Deno.TcpConn | undefined;
        let server: Deno.TcpConn | undefined;
        let timeout: ReturnType<typeof setTimeout> | undefined;
        try {
            client = await Deno.connect({ hostname: '127.0.0.1', port: listener.addr.port });
            server = await listener.accept();
            if (operation === 'cancel') await client.readable.cancel();
            else await client.writable.abort();

            const reader = server.readable.getReader();
            try {
                const result = await Promise.race([
                    reader.read(),
                    new Promise<never>((_, reject) => {
                        timeout = setTimeout(() => reject(new Error('connection remained open')), 1000);
                    }),
                ]);
                strictEqual(result.done, true);
            } finally {
                reader.releaseLock();
            }
        } finally {
            clearTimeout(timeout);
            client?.[Symbol.dispose]();
            server?.[Symbol.dispose]();
            listener.close();
        }
    });
}
