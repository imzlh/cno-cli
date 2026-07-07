import { ok, strictEqual } from 'node:assert';
import * as http from 'node:http';
import * as https from 'node:https';
import * as net from 'node:net';

const ssl = import.meta.use('ssl');

Deno.test({ name: 'tough-cookie: stores and matches scoped cookies', timeout: 30000 }, async () => {
    const mod = await import('npm:tough-cookie');
    const jar = new mod.CookieJar();
    await jar.setCookie('sid=abc; Path=/app; HttpOnly', 'https://example.test/app/login');
    const cookie = await jar.getCookieString('https://example.test/app/page');
    strictEqual(cookie, 'sid=abc');
    strictEqual(await jar.getCookieString('https://example.test/other'), '');
});

function listen(server: http.Server | https.Server | net.Server): Promise<number> {
    return new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(0, '127.0.0.1', () => {
            const address = server.address();
            if (!address || typeof address === 'string') reject(new Error('server did not expose a port'));
            else resolve(address.port);
        });
    });
}

function close(server: http.Server | https.Server | net.Server): Promise<void> {
    return new Promise((resolve) => server.close(() => resolve()));
}

function readHttp(url: string, options: http.RequestOptions | https.RequestOptions = {}): Promise<string> {
    return new Promise((resolve, reject) => {
        const client = url.startsWith('https:') ? https : http;
        const req = client.get(url, options, (res) => {
            res.setEncoding('utf8');
            let body = '';
            res.on('data', (chunk: string) => {
                body += chunk;
            });
            res.on('end', () => resolve(body));
        });
        req.once('error', reject);
    });
}

Deno.test({ name: 'http-proxy-agent and https-proxy-agent: proxy real requests', timeout: 30000 }, async () => {
    const httpMod = await import('npm:http-proxy-agent');
    const httpsMod = await import('npm:https-proxy-agent');

    let httpProxyHits = 0;
    const httpTarget = http.createServer((req, res) => {
        strictEqual(req.url, '/via-http-proxy');
        res.end('http-target-ok');
    });
    const httpTargetPort = await listen(httpTarget);
    const httpProxy = http.createServer((clientReq, clientRes) => {
        httpProxyHits++;
        const target = new URL(clientReq.url ?? '');
        strictEqual(target.hostname, '127.0.0.1');
        const upstream = http.request({
            hostname: target.hostname,
            port: target.port,
            path: `${target.pathname}${target.search}`,
            method: clientReq.method,
            headers: clientReq.headers,
        }, (upstreamRes) => {
            clientRes.writeHead(upstreamRes.statusCode ?? 502, upstreamRes.headers);
            upstreamRes.pipe(clientRes);
        });
        upstream.once('error', (error) => {
            clientRes.destroy(error);
        });
        clientReq.pipe(upstream);
    });

    const { cert, key } = ssl.createSelfSignedCert({ commonName: '127.0.0.1', days: 1 });
    const httpsTarget = https.createServer({ cert, key }, (req, res) => {
        strictEqual(req.url, '/via-https-proxy');
        res.end('https-target-ok');
    });
    const httpsTargetPort = await listen(httpsTarget);
    let connectHits = 0;
    const connectProxy = net.createServer((clientSocket) => {
        clientSocket.once('data', (data) => {
            const requestText = String(data);
            const headerEnd = requestText.indexOf('\r\n\r\n');
            ok(headerEnd !== -1);
            const [method, authority] = requestText.slice(0, headerEnd).split(/\s+/);
            strictEqual(method, 'CONNECT');
            connectHits++;
            const [host, portText] = authority.split(':');
            strictEqual(host, '127.0.0.1');
            const upstream = net.connect(Number(portText), host, () => {
                clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
                const head = data.subarray(headerEnd + 4);
                if (head.length > 0) upstream.write(head);
                upstream.pipe(clientSocket);
                clientSocket.pipe(upstream);
            });
            upstream.once('error', () => clientSocket.destroy());
        });
    });

    try {
        const httpProxyPort = await listen(httpProxy);
        const connectProxyPort = await listen(connectProxy);
        const httpAgent = new httpMod.HttpProxyAgent(`http://127.0.0.1:${httpProxyPort}`);
        const httpsAgent = new httpsMod.HttpsProxyAgent(`http://127.0.0.1:${connectProxyPort}`);

        const httpBody = await readHttp(`http://127.0.0.1:${httpTargetPort}/via-http-proxy`, { agent: httpAgent });
        const httpsBody = await readHttp(`https://127.0.0.1:${httpsTargetPort}/via-https-proxy`, {
            agent: httpsAgent,
            rejectUnauthorized: false,
        });

        strictEqual(httpBody, 'http-target-ok');
        strictEqual(httpsBody, 'https-target-ok');
        strictEqual(httpProxyHits, 1);
        strictEqual(connectHits, 1);
    } finally {
        await close(httpProxy);
        await close(connectProxy);
        await close(httpTarget);
        await close(httpsTarget);
    }
});
