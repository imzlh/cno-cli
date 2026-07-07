/**
 * worker/server.ts — the DevTools-facing HTTP + WebSocket endpoint.
 *
 * Serves the CDP discovery JSON (`/json`, `/json/list`, `/json/version`) so a
 * DevTools frontend can find us, then upgrades the well-known WS path to a raw
 * connection and wraps it as a WebSocket. Connection wiring (binding the socket
 * to the dispatcher) is delegated to the caller via `onConnect`, so this file
 * stays purely about transport.
 */

import { Server, type HttpRequest, type HttpResponse } from '@cnojs/http/server';
import { createWebSocketFromConnection } from '../../../cno/src/webapi/websocket';
import { log } from '../../../cts/src/api';

const engine = import.meta.use('engine');
const nativeCrypto = import.meta.use('crypto');

const WS_MAGIC = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11'

export interface ServerOptions {
	port: number
	host?: string
	entryUrl: string
	onConnect: (ws: WebSocket) => void
}

export interface ServerHandle {
	wsUrl: string
	close: () => void
}

export function startServer(opts: ServerOptions): Promise<ServerHandle> {
	const { port, entryUrl, onConnect } = opts
	const targetId = 'ws/' + nativeCrypto.randomUUID()
	const wsPath = `/${targetId}`
	const hostname = opts.host || '127.0.0.1'
	const host = `${hostname}:${port}`
	const wsUrl = `ws://${host}${wsPath}`

	async function respondJson(res: HttpResponse, value: unknown): Promise<void> {
		const body = JSON.stringify(value)
		const bytes = engine.encodeString(body)
		await res.writeHead(200, 'OK', [
			['Content-Type', 'application/json; charset=UTF-8'],
			['Content-Length', String(bytes.length)],
		])
		await res.end(body)
	}

	const listEntry = {
		description: 'cno',
		devtoolsFrontendUrl: `devtools://devtools/bundled/js_app.html?experiments=true&v8only=true&ws=${host}${wsPath}`,
		id: targetId,
		title: 'cno',
		type: 'page',
		url: entryUrl,
		webSocketDebuggerUrl: wsUrl,
	}
	const versionInfo = {
		Browser: 'cno/1.0',
		'Protocol-Version': '1.3',
		'User-Agent': 'cno',
		'V8-Version': '14.9.207.27',	// Chrome 149
		'WebKit-Version': '0.0',
		webSocketDebuggerUrl: wsUrl,
	}

	const server = new Server(async (req: HttpRequest, res: HttpResponse): Promise<void> => {
		const path = req.url.split('?')[0]
		const headers = Object.fromEntries(req.headers);

		if (path === wsPath && (headers['upgrade'] ?? '').toLowerCase() === 'websocket') {
			const wsKey = headers['sec-websocket-key'] ?? ''
			const digest = nativeCrypto.sha1(engine.encodeString(wsKey + WS_MAGIC))
			const accept = nativeCrypto.base64Encode(new Uint8Array(digest))
			await res.writeHead(101, 'Switching Protocols', [
				['Upgrade', 'websocket'],
				['Connection', 'Upgrade'],
				['Sec-WebSocket-Accept', accept],
			])
			const rawConn = res.upgrade()
			const ws = createWebSocketFromConnection(Promise.resolve(rawConn));
			ws.onopen = (): void => {
				log.debug('debug', () => `devtools ws: new connection to ${wsPath}`)
				onConnect(ws)
			}
			return
		}

		if (path === '/json' || path === '/json/list') {
			await respondJson(res, [listEntry])
			return
		}
		if (path === '/json/version') {
			await respondJson(res, versionInfo)
			return
		}

		await res.writeHead(404, 'Not Found', [['Content-Length', '0']])
		await res.end()
	}, { port, hostname })

	server.listen()
	void server.acceptLoop()
	return Promise.resolve({ wsUrl, close: () => server.close() })
}
