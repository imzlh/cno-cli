/**
 * domains/network.ts — Network CDP domain (worker thread).
 *
 * Translates cno's native fetch / websocket hook events (delivered over the
 * wire as discriminated `NetFetchEvent` / `NetWSEvent` unions) into the CDP
 * Network.* events DevTools expects, and answers body/cookie queries from a
 * bounded local cache. Response bodies are buffered up to a cap so the Network
 * tab can show payloads without unbounded memory growth.
 */

import { Domain } from './base'
import type { CDPDispatcher, EmitEvent } from '../worker/dispatcher'
import {
	setUserAgentOverride,
	setExtraHTTPHeaders,
} from '../../../cno/src/utils/network-hooks'
import {
	NetFetchKind,
	NetWSKind,
	type NetFetchEvent,
	type NetWSEvent,
	type FetchConnection,
} from '../shared/wire'

const engine = import.meta.use('engine');
const text = import.meta.use('text');

const MAX_CACHED_BODIES = 200
const MAX_BODY_BYTES = 1024 * 1024 // 1 MiB

interface Cookie {
	name: string
	value: string
	domain: string
	path: string
	expires: number
	size: number
	httpOnly: boolean
	secure: boolean
	session: boolean
	sameSite?: string
}

interface RequestMeta {
	url: string
	requestHeaders: Record<string, string>
	responseHeaders: Record<string, string>
	status: number
}

interface BodyEntry {
	chunks: Uint8Array[]
	total: number
	truncated: boolean
}

function protocolFromVersion(version?: number): string {
	switch (version) {
		case 30: return 'h3'      // CURL_HTTP_VERSION_3
		case 3: return 'h2'       // CURL_HTTP_VERSION_2
		case 4: return 'h2'       // CURL_HTTP_VERSION_2_PRIOR_KNOWLEDGE
		case 2: return 'http/1.1' // CURL_HTTP_VERSION_1_1
		case 1: return 'http/1.0' // CURL_HTTP_VERSION_1_0
		default: return 'fetch'
	}
}

const STATUS_TEXT: Record<number, string> = {
	200: 'OK', 201: 'Created', 204: 'No Content', 206: 'Partial Content',
	301: 'Moved Permanently', 302: 'Found', 304: 'Not Modified', 307: 'Temporary Redirect', 308: 'Permanent Redirect',
	400: 'Bad Request', 401: 'Unauthorized', 403: 'Forbidden', 404: 'Not Found', 405: 'Method Not Allowed',
	429: 'Too Many Requests', 500: 'Internal Server Error', 502: 'Bad Gateway', 503: 'Service Unavailable', 504: 'Gateway Timeout',
}

function statusText(status: number): string {
	return STATUS_TEXT[status] ?? ''
}

export class NetworkDomain extends Domain {
	private enabled = false
	private cookies: Cookie[] = []
	private responseBodyCache = new Map<string, BodyEntry>()
	private pendingBodies = new Map<string, BodyEntry>()
	private reqStartTimes = new Map<string, number>()
	private reqMeta = new Map<string, RequestMeta>()

	constructor(dispatcher: CDPDispatcher, event: EmitEvent) {
		super(dispatcher, event)
		this.registerHandlers()
	}

	private registerHandlers(): void {
		this.on('Network.enable', () => {
			this.enabled = true
			return {}
		})
		this.on('Network.disable', () => {
			this.enabled = false
			this.cookies = []
			this.reqStartTimes.clear()
			this.reqMeta.clear()
			this.pendingBodies.clear()
			this.responseBodyCache.clear()
			return {}
		})
		this.on('Network.setUserAgentOverride', (p) => {
			setUserAgentOverride(this.str(p, 'userAgent') || null)
			return {}
		})
		this.on('Network.setExtraHTTPHeaders', (p) => {
			const headers = (p.headers ?? {}) as Record<string, string>
			setExtraHTTPHeaders(headers)
			return {}
		})
		this.on('Network.canEmulateNetworkConditions', () => ({ result: false }))
		this.on('Network.emulateNetworkConditions', () => ({}))
		this.on('Network.setCacheDisabled', () => ({}))
		this.on('Network.setBypassServiceWorker', () => ({}))
		this.on('Network.setAcceptedEncodings', () => ({}))
		this.on('Network.clearAcceptedEncodingsOverride', () => ({}))
		this.on('Network.setAttachDebugStack', () => ({}))
		this.on('Network.replayXHR', () => ({}))
		this.on('Network.streamResourceContent', () => ({ bufferedData: '' }))
		this.on('Network.searchInResponseBody', () => ({ result: [] }))

		// Cookies.
		this.on('Network.getCookies', () => ({ cookies: this.cookies }))
		this.on('Network.getAllCookies', () => ({ cookies: this.cookies }))
		this.on('Network.deleteCookies', (p) => {
			const name = this.str(p, 'name')
			this.cookies = this.cookies.filter((c) => c.name !== name)
			return {}
		})
		this.on('Network.clearBrowserCookies', () => {
			this.cookies = []
			return {}
		})
		this.on('Network.setCookie', (p) => {
			this.cookies.push(this.makeCookie(p))
			return { success: true }
		})
		this.on('Network.setCookies', (p) => {
			const list = (p.cookies ?? []) as Array<Record<string, unknown>>
			for (const c of list) this.cookies.push(this.makeCookie(c))
			return {}
		})
		this.on('Network.clearBrowserCache', () => ({}))

		// Bodies.
		this.on('Network.getResponseBody', (p) => {
			const entry = this.responseBodyCache.get(this.reqStr(p, 'requestId'))
			if (!entry) return { body: '', base64Encoded: false }
			const body = this.decodeBody(entry)
			return { body, base64Encoded: false }
		})
		this.on('Network.getRequestPostData', () => ({ postData: '' }))
	}

	private makeCookie(p: Record<string, unknown>): Cookie {
		const name = typeof p.name === 'string' ? p.name : ''
		const value = typeof p.value === 'string' ? p.value : ''
		return {
			name,
			value,
			domain: typeof p.domain === 'string' ? p.domain : '',
			path: typeof p.path === 'string' ? p.path : '/',
			expires: typeof p.expires === 'number' ? p.expires : -1,
			size: name.length + value.length,
			httpOnly: p.httpOnly === true,
			secure: p.secure === true,
			session: p.expires == null,
			sameSite: typeof p.sameSite === 'string' ? p.sameSite : undefined,
		}
	}

	// ── fetch hook → CDP ──────────────────────────────────────────
	onFetchEvent(data: NetFetchEvent): void {
		if (!this.enabled) return
		switch (data.ev) {
			case NetFetchKind.Req: {
				this.reqStartTimes.set(data.requestId, data.timestamp)
				this.reqMeta.set(data.requestId, {
					url: data.url,
					requestHeaders: data.headers,
					responseHeaders: {},
					status: 0,
				})
				this.event('Network.requestWillBeSent', {
					requestId: data.requestId,
					loaderId: data.requestId,
					documentURL: data.url,
					request: {
						url: data.url,
						method: data.method,
						headers: data.headers,
						hasPostData: data.postData != null,
						postData: data.postData ? this.truncateUtf8(data.postData, 1024) : undefined,
						initialPriority: 'High',
						referrerPolicy: 'strict-origin-when-cross-origin',
						isLinkPreload: false,
					},
					timestamp: data.timestamp,
					wallTime: data.timestamp,
					initiator: { type: 'script' },
					hasExtraInfo: true,
					redirectHasExtraInfo: false,
					type: 'Fetch',
					frameId: 'cno-frame-1',
				})
				this.event('Network.requestWillBeSentExtraInfo', {
					requestId: data.requestId,
					headers: data.headers,
				})
				break
			}
			case NetFetchKind.Res: {
				const start = this.reqStartTimes.get(data.requestId) ?? data.timestamp
				const meta = this.reqMeta.get(data.requestId)
				if (meta) {
					meta.responseHeaders = data.headers
					meta.status = data.status
				}
				const conn = data.connection
				const t = conn?.timing
				this.event('Network.responseReceived', {
					requestId: data.requestId,
					loaderId: data.requestId,
					timestamp: data.timestamp,
					type: 'Fetch',
					frameId: 'cno-frame-1',
					hasExtraInfo: true,
					response: {
						url: data.url ?? meta?.url ?? '',
						status: data.status,
						statusText: statusText(data.status),
						headers: data.headers,
						mimeType: t?.contentType ?? data.headers['content-type'] ?? data.headers['Content-Type'] ?? '',
						connectionReused: (t?.numConnects ?? 1) === 0,
						connectionId: conn ? this.connectionId(conn) : 0,
						remoteIPAddress: conn?.remoteIPAddress ?? '',
						remotePort: conn?.remotePort ?? 0,
						fromDiskCache: false,
						fromServiceWorker: false,
						encodedDataLength: t?.headerSize ?? 0,
						protocol: protocolFromVersion(conn?.httpVersion),
						securityState: this.securityState(t?.sslVerifyResult),
						timing: this.buildTiming(start, conn),
					},
				})
				this.event('Network.responseReceivedExtraInfo', {
					requestId: data.requestId,
					headers: data.headers,
					headersText: this.buildHeadersText(data.headers, data.status, conn?.httpVersion),
					statusCode: data.status,
				})
				break
			}
			case NetFetchKind.Data: {
				let entry = this.pendingBodies.get(data.requestId)
				if (!entry) {
					entry = { chunks: [], total: 0, truncated: false }
					this.pendingBodies.set(data.requestId, entry)
				}
				if (entry.total + data.byteLength <= MAX_BODY_BYTES) {
					entry.chunks.push(data.data)
					entry.total += data.byteLength
				} else {
					entry.truncated = true
				}
				this.event('Network.dataReceived', {
					requestId: data.requestId,
					timestamp: data.timestamp,
					dataLength: data.byteLength,
					encodedDataLength: data.byteLength,
				})
				break
			}
			case NetFetchKind.Done: {
				const entry = this.pendingBodies.get(data.requestId)
				this.pendingBodies.delete(data.requestId)
				if (entry) {
					if (this.responseBodyCache.size >= MAX_CACHED_BODIES) {
						const oldest = this.responseBodyCache.keys().next().value
						if (oldest !== undefined) this.responseBodyCache.delete(oldest)
					}
					this.responseBodyCache.set(data.requestId, entry)
				}
				const conn = data.connection
				if (data.success) {
					this.event('Network.loadingFinished', {
						requestId: data.requestId,
						timestamp: data.timestamp,
						encodedDataLength: conn?.timing?.sizeDownload ?? conn?.downloadSize ?? entry?.total ?? 0,
						shouldReportCorbBlocking: false,
					})
					// Synthesize redirect events so DevTools shows the hop chain.
					const redirects = conn?.timing?.redirectCount ?? 0
					if (redirects > 0 && meta) {
						const redirectUrl = conn?.timing?.redirectUrl ?? ''
						this.event('Network.requestWillBeSent', {
							requestId: `${data.requestId}:redirect:${redirects}`,
							loaderId: data.requestId,
							documentURL: redirectUrl,
							request: { url: redirectUrl, method: 'GET', headers: {}, initialPriority: 'High', referrerPolicy: 'strict-origin-when-cross-origin', isLinkPreload: false },
							timestamp: data.timestamp,
							wallTime: data.timestamp,
							initiator: { type: 'script' },
							redirectResponse: { url: meta.url, status: data.status, statusText: statusText(data.status), headers: data.headers, mimeType: conn?.timing?.contentType ?? '' },
							type: 'Fetch',
							frameId: 'cno-frame-1',
						})
					}
				} else {
					this.event('Network.loadingFailed', {
						requestId: data.requestId,
						timestamp: data.timestamp,
						type: 'Fetch',
						errorText: data.errorText ?? 'net::ERR_FAILED',
						canceled: false,
					})
				}
				this.reqStartTimes.delete(data.requestId)
				this.reqMeta.delete(data.requestId)
				break
			}
		}
	}

	// ── websocket hook → CDP ─────────────────────────────────────
	onWSEvent(data: NetWSEvent): void {
		if (!this.enabled) return
		switch (data.ev) {
			case NetWSKind.Created:
				this.event('Network.webSocketCreated', {
					requestId: data.requestId,
					url: data.url,
					initiator: { type: 'script' },
				})
				break
			case NetWSKind.Handshake: {
				const hdrs: Record<string, string> = {}
				for (const [k, v] of data.headers) hdrs[k] = v
				this.event('Network.webSocketHandshakeResponseReceived', {
					requestId: data.requestId,
					timestamp: data.timestamp,
					response: {
						status: data.status,
						statusText: statusText(data.status),
						headers: hdrs,
						headersText: '',
						requestHeaders: {},
						requestHeadersText: '',
					},
				})
				break
			}
			case NetWSKind.Recv:
				this.event('Network.webSocketFrameReceived', {
					requestId: data.requestId,
					timestamp: data.timestamp,
					response: { opcode: data.opcode, mask: data.masked, payloadData: data.payloadData },
				})
				break
			case NetWSKind.Sent:
				this.event('Network.webSocketFrameSent', {
					requestId: data.requestId,
					timestamp: data.timestamp,
					response: { opcode: data.opcode, mask: data.masked, payloadData: data.payloadData },
				})
				break
			case NetWSKind.Closed:
				this.event('Network.webSocketClosed', { requestId: data.requestId, timestamp: data.timestamp })
				break
		}
	}

	private buildTiming(start: number, conn?: FetchConnection): Record<string, number> {
		// Use curl's absolute *End timestamps (seconds since epoch) and compute
		// per-phase ms deltas.  Duration fields are cumulative from request start
		// (receiveHeadersDuration = full TTFB), so summing them over-counts.
		const t = conn?.timing
		if (!t) return { ...EMPTY_TIMING, requestTime: start }

		const out: Record<string, number> = { ...EMPTY_TIMING, requestTime: start }

		const ms = (abs: number | undefined): number =>
			abs != null ? Math.round((abs - start) * 1000) : -1

		const dnsStartMs = 0
		const dnsEndMs = ms(t.dnsEnd)
		if (dnsEndMs >= 0) { out.dnsStart = dnsStartMs; out.dnsEnd = dnsEndMs }

		const connStartMs = dnsEndMs >= 0 ? dnsEndMs : 0
		const connEndMs = ms(t.connectEnd)
		if (connEndMs >= 0) { out.connectStart = connStartMs; out.connectEnd = connEndMs }

		const sslStartMs = connEndMs >= 0 ? connEndMs : connStartMs
		const sslEndMs = ms(t.sslEnd)
		if (sslEndMs >= 0 && sslEndMs > sslStartMs) { out.sslStart = sslStartMs; out.sslEnd = sslEndMs }

		const sendStartMs = sslEndMs >= 0 ? sslEndMs : connEndMs >= 0 ? connEndMs : 0
		const sendEndMs = ms(t.sendEnd)
		if (sendEndMs >= 0) { out.sendStart = sendStartMs; out.sendEnd = sendEndMs }

		const recvStartMs = ms(t.receiveHeadersStart)
		if (recvStartMs >= 0) {
			out.receiveHeadersStart = sendEndMs >= 0 ? sendEndMs : recvStartMs
			out.receiveHeadersEnd = recvStartMs
		}

		// Content download: TTFB → transfer complete (CURLINFO_TOTAL_TIME).
		if (t.totalTime != null) {
			const contentEndMs = Math.round(t.totalTime * 1000)
			out.receiveContentStart = recvStartMs >= 0 ? recvStartMs : sendEndMs >= 0 ? sendEndMs : 0
			out.receiveContentEnd = contentEndMs
		}

		return out
	}

	private buildHeadersText(headers: Record<string, string>, status: number, httpVersion?: number): string {
		// h2+ has no textual status line; HTTP/1.x uses version-specific line.
		if (httpVersion === 3 || httpVersion === 4 || httpVersion === 30) return this.headerBlock(headers)
		const proto = httpVersion === 1 ? 'HTTP/1.0' : 'HTTP/1.1'
		return `${proto} ${status} ${statusText(status)}\r\n` + this.headerBlock(headers)
	}

	private headerBlock(headers: Record<string, string>): string {
		let out = ''
		for (const key of Object.keys(headers)) out += `${key}: ${headers[key]}\r\n`
		return out + '\r\n'
	}

	private decodeBody(entry: BodyEntry): string {
		const decoder = new text.Decoder()
		let out = ''
		for (const chunk of entry.chunks) out += decoder.decode(chunk, { stream: true })
		out += decoder.decode(new Uint8Array(0))
		return out
	}

	private truncateUtf8(bytes: Uint8Array, maxBytes: number): string {
		const len = Math.min(bytes.byteLength, maxBytes)
		const slice = bytes.subarray(0, len)
		return engine.decodeString(slice)
	}

	private connectionId(conn: FetchConnection): number {
		const s = `${conn.remoteIPAddress ?? ''}:${conn.remotePort ?? 0}`
		let h = 0
		for (let i = 0; i < s.length; i++) h = ((h << 5) - h + s.charCodeAt(i)) | 0
		return h >>> 0
	}

	private securityState(sslVerifyResult?: number): string {
		if (sslVerifyResult == null) return 'neutral'
		return sslVerifyResult === 0 ? 'secure' : 'insecure'
	}
}

const EMPTY_TIMING: Record<string, number> = {
	requestTime: -1,
	// Deno HttpClient uses curl; proxy overhead is included in connect timing.
	proxyStart: -1, proxyEnd: -1,
	dnsStart: -1, dnsEnd: -1,
	connectStart: -1, connectEnd: -1,
	sslStart: -1, sslEnd: -1,
	workerStart: -1, workerReady: -1, workerFetchStart: -1, workerRespondWithSettled: -1,
	sendStart: -1, sendEnd: -1,
	pushStart: -1, pushEnd: -1,
	receiveHeadersStart: -1, receiveHeadersEnd: -1,
	receiveContentStart: -1, receiveContentEnd: -1,
}
