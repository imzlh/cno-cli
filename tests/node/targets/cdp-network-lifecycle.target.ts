/**
 * Target for cdp-network-lifecycle.test.ts.
 *
 * Starts a LOOPBACK http server (so the peer is never the variable) and then
 * drives, in a loop, the request shapes whose CDP event streams the test needs
 * to inspect:
 *   /ok        200 with a small text body
 *   /redirect  302 -> /final, so a redirect CHAIN is exercised
 *   /slow      headers sent, body never finished (aborted client-side)
 *   /a, /b     two concurrent requests, interleaved on purpose
 * plus one request issued from a WORKER, to check session attribution.
 *
 * The loop runs forever; the test attaches, enables Network, samples a window of
 * events and kills the child. A liveness line goes to stderr each cycle so a
 * silent hang is distinguishable from a slow pass.
 */

import { createServer } from 'node:http';
import { Worker } from 'node:worker_threads';

const server = createServer((req, res) => {
	const url = req.url ?? '/';
	if (url === '/redirect') {
		res.writeHead(302, { location: '/final' });
		res.end();
		return;
	}
	if (url === '/final') {
		res.writeHead(200, { 'content-type': 'text/plain' });
		res.end('FINAL-BODY');
		return;
	}
	if (url === '/slow') {
		res.writeHead(200, { 'content-type': 'text/plain', 'transfer-encoding': 'chunked' });
		res.write('partial');
		// never end: the client aborts this one
		return;
	}
	if (url === '/a') {
		res.writeHead(200, { 'content-type': 'text/plain' });
		setTimeout(() => res.end('AAAA'), 40);
		return;
	}
	if (url === '/b') {
		res.writeHead(200, { 'content-type': 'text/plain' });
		res.end('BBBB');
		return;
	}
	res.writeHead(200, { 'content-type': 'text/plain' });
	res.end('OK-BODY');
});

await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
const addr = server.address();
const port = typeof addr === 'object' && addr ? addr.port : 0;
const base = `http://127.0.0.1:${port}`;
// The test reads this line to learn the loopback port.
console.log(`SERVER_PORT=${port}`);

const workerSource = `
import { parentPort, workerData } from 'node:worker_threads';
const base = workerData.base;
for (;;) {
	try { await fetch(base + '/ok?from=worker').then((r) => r.text()); } catch {}
	await new Promise((r) => setTimeout(r, 250));
}
`;
const worker = new Worker(new URL(`data:text/typescript,${encodeURIComponent(workerSource)}`), {
	workerData: { base },
});
worker.unref();

let cycle = 0;
for (;;) {
	cycle++;
	// 1. plain request
	try { await fetch(`${base}/ok`).then((r) => r.text()); } catch {}
	// 2. redirect chain, followed
	try { await fetch(`${base}/redirect`).then((r) => r.text()); } catch {}
	// 3. aborted mid-flight
	try {
		const ac = new AbortController();
		const p = fetch(`${base}/slow`, { signal: ac.signal }).then((r) => r.text());
		setTimeout(() => ac.abort(), 30);
		await p;
	} catch {}
	// 4. two concurrent, interleaving
	try { await Promise.all([fetch(`${base}/a`).then((r) => r.text()), fetch(`${base}/b`).then((r) => r.text())]); } catch {}

	console.error(`[target] cycle ${cycle} complete`);
	await new Promise((r) => setTimeout(r, 150));
}
