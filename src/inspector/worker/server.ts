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
	/** Bearer required on the websocket upgrade and on /json discovery. */
	token?: string
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
	const token = opts.token ?? nativeCrypto.randomUUID()
	const wsUrl = `ws://${host}${wsPath}?token=${encodeURIComponent(token)}`

	async function respondJson(res: HttpResponse, value: unknown): Promise<void> {
		const body = JSON.stringify(value)
		const bytes = engine.encodeString(body)
		await res.writeHead(200, 'OK', [
			['Content-Type', 'application/json; charset=UTF-8'],
			['Content-Length', String(bytes.length)],
		])
		await res.end(body)
	}

	// Timing-safe token comparison to avoid leaking leading bytes via response time.
	function safeEqual(a: string, b: string): boolean {
		if (a.length !== b.length) return false;
		let r = 0;
		for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
		return r === 0;
	}
	function hasValidToken(req: HttpRequest): boolean {
		const url = new URL(req.url, `ws://${host}`)
		const headerToken = req.headers.find(([n]) => n.toLowerCase() === 'x-cdp-token')?.[1] ?? ''
		return safeEqual(url.searchParams.get('token') ?? '', token) || safeEqual(headerToken, token)
	}

	function isValidPort(value: string): boolean {
		if (!/^\d+$/.test(value)) return false
		const port = Number(value)
		return port >= 0 && port <= 65535
	}

	function isIpv4Literal(value: string): boolean {
		const parts = value.split('.')
		return parts.length === 4 && parts.every((part) => {
			if (!/^\d{1,3}$/.test(part)) return false
			return Number(part) <= 255
		})
	}

	/** Do not rely on URL parsing here: the cno polyfill accepts invalid bracketed hosts. */
	function isIpv6Literal(value: string): boolean {
		if (value === '' || value.includes('%')) return false	// zone IDs are invalid in a URL host
		const halves = value.split('::')
		if (halves.length > 2) return false
		const compressed = halves.length === 2
		const head = halves[0] === '' ? [] : halves[0]!.split(':')
		const tail = compressed ? (halves[1] === '' ? [] : halves[1]!.split(':')) : []
		const groups = [...head, ...tail]
		// A trailing IPv4 form (::ffff:1.2.3.4) occupies the last two groups.
		let count = groups.length
		const last = groups[count - 1]
		if (last !== undefined && last.includes('.')) {
			if (!isIpv4Literal(last)) return false
			count += 1
		}
		if (compressed ? count > 7 : count !== 8) return false
		return groups.every((g, i) => (i === groups.length - 1 && g.includes('.')) || /^[0-9a-f]{1,4}$/.test(g))
	}

	/**
	 * DNS-rebinding guard, matching what the Node inspector does: a browser can be
	 * tricked into resolving an attacker domain to 127.0.0.1, but it cannot forge
	 * the Host header, so only IP literals and `localhost` are accepted. Verified
	 * against real node v24.18: Host 127.0.0.1/localhost/[::1] -> 200, evil.com -> 400.
	 */
	function isAllowedHost(hostHeader: string | undefined): boolean {
		// No Host at all is HTTP/1.0 or a raw non-browser client; a browser always sends one.
		if (hostHeader === undefined || hostHeader === '') return true
		let name = hostHeader.trim().toLowerCase()
		if (name.startsWith('[')) {
			const close = name.indexOf(']')
			if (close === -1) return false
			const rest = name.slice(close + 1)
			if (rest !== '' && (!rest.startsWith(':') || !isValidPort(rest.slice(1)))) return false
			return isIpv6Literal(name.slice(1, close))
		}
		const colonCount = name.split(':').length - 1
		if (colonCount > 1) return isIpv6Literal(name)
		if (colonCount === 1) {
			const colon = name.lastIndexOf(':')
			if (!isValidPort(name.slice(colon + 1))) return false
			name = name.slice(0, colon)
		}
		if (name === 'localhost') return true
		if (name === hostname.toLowerCase()) return true	// the address we were told to bind
		return isIpv4Literal(name)
	}

	/**
	 * A DevTools frontend sends no Origin on the upgrade; a page driven by an
	 * attacker always does. Reject cross-origin upgrades so a rebound page cannot
	 * drive the debugger (which is arbitrary code execution) even if it guesses the URL.
	 */
	function isAllowedOrigin(origin: string | undefined): boolean {
		if (origin === undefined || origin === '') return true
		if (origin.startsWith('devtools://') || origin.startsWith('chrome-devtools://')) return true
		try {
			return isAllowedHost(new URL(origin).host)
		} catch {
			return false
		}
	}

	// The `ws=` value must carry the token: it is the only thing DevTools uses to
	// build the socket URL, and the upgrade is token-gated. Without it every
	// "inspect" click from chrome://inspect gets a 403. A literal `?` inside a
	// query value is legal (RFC 3986 query = *( pchar / "/" / "?" )) and
	// URLSearchParams.get('ws') returns it intact, so keep the URL readable
	// rather than percent-encoding the whole thing. `ws` stays last so the
	// nested query cannot swallow a following parameter.
	const wsRef = `${host}${wsPath}?token=${encodeURIComponent(token)}`

	const listEntry = {
		description: 'cno',
		devtoolsFrontendUrl: `devtools://devtools/bundled/js_app.html?experiments=true&v8only=true&ws=${wsRef}`,
		id: targetId,
		title: 'cno',
		type: 'node',
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
		const headers = Object.fromEntries(req.headers.map(([n, v]): [string, string] => [n.toLowerCase(), v]));

		// Applied to every route: the discovery JSON leaks the ws URL + token, so it
		// must be unreachable from a rebound origin even though it needs no token.
		// Every Host occurrence must pass: the H1 parser does not reject duplicate
		// Host headers, and a last-wins lookup would let `evil.com, 127.0.0.1` through.
		const hostValues = req.headers.filter(([n]) => n.toLowerCase() === 'host').map(([, v]) => v)
		if (!hostValues.every((v) => isAllowedHost(v))) {
			await res.writeHead(400, 'Bad Request', [['Content-Length', '0']]); await res.end(); return
		}

		if (path === wsPath && (headers['upgrade'] ?? '').toLowerCase() === 'websocket') {
			const originValues = req.headers.filter(([n]) => n.toLowerCase() === 'origin').map(([, v]) => v)
			if (!originValues.every((v) => isAllowedOrigin(v))) {
				await res.writeHead(403, 'Forbidden', [['Content-Length', '0']]); await res.end(); return
			}
			if (!hasValidToken(req)) {
				await res.writeHead(403, 'Forbidden', [['Content-Length', '0']]); await res.end(); return;
			}
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

		// Discovery is intentionally unauthenticated, exactly as the real node
		// inspector serves it: a client must read /json/version to learn the ws URL
		// and its token, so gating these on that same token can never succeed.
		// The DNS-rebinding defense is the Host check above, not secrecy here.
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
