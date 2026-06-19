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
	NetServeKind,
	NetWSKind,
	type ConsoleCallFrame,
	type NetFetchEvent,
	type NetServeEvent,
	type NetWSEvent,
	type FetchConnection,
} from '../shared/wire'

const engine = import.meta.use('engine');
const nativeCrypto = import.meta.use('crypto');

const MAX_CACHED_BODIES = 200
const MAX_BODY_BYTES = 1024 * 1024 // 1 MiB
const FRAME_ID = 'cno-frame-1'
const LOADER_ID = 'cno-loader-1'

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
	method: string
	requestHeaders: Record<string, string>
	responseHeaders: Record<string, string>
	status: number
	initiator: Record<string, unknown>
	resourceType: string
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

function isInternalNetworkFrame(url: string, functionName: string): boolean {
	const text = `${url} ${functionName}`
	return url === '<core>' || functionName === '<core>' || /(?:webapi[\\/])?fetch\.ts|deno[\\/]08_serve\.ts|network-hooks\.ts|captureNetworkCallFrames|captureServeCallFrames|onRequest|Hooks\.installNetwork/.test(text)
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
			if (!entry) return { body: '', base64Encoded: true }
			return { body: this.encodeBodyBase64(entry), base64Encoded: true }
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
				const timestamp = data.timestamp
				const initiator = this.buildInitiator(data.callFrames)
				const resourceType = data.resourceType ?? 'Fetch'
				this.reqStartTimes.set(data.requestId, timestamp)
				this.reqMeta.set(data.requestId, {
					url: data.url,
					method: data.method,
					requestHeaders: data.headers,
					responseHeaders: {},
					status: 0,
					initiator,
					resourceType,
				})
				this.event('Network.requestWillBeSent', {
					requestId: data.requestId,
					loaderId: LOADER_ID,
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
					timestamp,
					wallTime: data.timestamp,
					initiator,
					hasExtraInfo: true,
					redirectHasExtraInfo: false,
					type: resourceType,
					frameId: FRAME_ID,
				})
				break
			}
			case NetFetchKind.Res: {
				const timestamp = data.timestamp
				const start = this.reqStartTimes.get(data.requestId) ?? timestamp
				const meta = this.reqMeta.get(data.requestId)
				const resourceType = meta?.resourceType ?? 'Fetch'
				if (meta) {
					meta.responseHeaders = data.headers
					meta.status = data.status
				}
				const conn = data.connection
				const t = conn?.timing
				const url = data.url ?? meta?.url ?? ''
				const requestHeaders = data.requestHeaders ?? meta?.requestHeaders ?? {}
				const responseHeadersText = t?.responseHeadersText ?? this.buildHeadersText(data.headers, data.status, conn?.httpVersion)
				const requestHeadersText = t?.requestHeadersText ?? this.buildRequestHeadersText(meta?.method ?? 'GET', url, requestHeaders, conn?.httpVersion)
				const actualRequestHeaders = this.headersTextToRecord(requestHeadersText, requestHeaders)
				this.event('Network.requestWillBeSentExtraInfo', {
					requestId: data.requestId,
					associatedCookies: [],
					headers: actualRequestHeaders,
					connectTiming: { requestTime: start },
					siteHasCookieInOtherPartition: false,
				})
				this.event('Network.responseReceived', {
					requestId: data.requestId,
					loaderId: LOADER_ID,
					timestamp,
					type: resourceType,
					frameId: FRAME_ID,
					hasExtraInfo: true,
					response: {
						url,
						status: data.status,
						statusText: statusText(data.status),
						headers: data.headers,
						headersText: responseHeadersText,
						requestHeaders: actualRequestHeaders,
						requestHeadersText,
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
						timing: this.normalizeTiming(this.buildTiming(start, conn)),
					},
				})
				this.event('Network.responseReceivedExtraInfo', {
					requestId: data.requestId,
					blockedCookies: [],
					headers: data.headers,
					headersText: responseHeadersText,
					resourceIPAddressSpace: 'Unknown',
					statusCode: data.status,
					exemptedCookies: [],
				})
				break
			}
			case NetFetchKind.Data: {
				const timestamp = data.timestamp
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
					timestamp,
					dataLength: data.byteLength,
					encodedDataLength: data.byteLength,
				})
				break
			}
			case NetFetchKind.Done: {
				const timestamp = data.timestamp
				const meta = this.reqMeta.get(data.requestId)
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
						timestamp,
						encodedDataLength: conn?.timing?.sizeDownload ?? conn?.downloadSize ?? entry?.total ?? 0,
						shouldReportCorbBlocking: false,
					})
					// Synthesize redirect events so DevTools shows the hop chain.
					const redirects = conn?.timing?.redirectCount ?? 0
					if (redirects > 0 && meta) {
						const redirectUrl = conn?.timing?.redirectUrl ?? ''
						this.event('Network.requestWillBeSent', {
							requestId: `${data.requestId}:redirect:${redirects}`,
							loaderId: LOADER_ID,
							documentURL: redirectUrl,
							request: { url: redirectUrl, method: 'GET', headers: {}, initialPriority: 'High', referrerPolicy: 'strict-origin-when-cross-origin', isLinkPreload: false },
							timestamp,
							wallTime: data.timestamp,
							initiator: meta.initiator,
							redirectResponse: { url: meta.url, status: meta.status, statusText: statusText(meta.status), headers: meta.responseHeaders, mimeType: conn?.timing?.contentType ?? '' },
							type: meta.resourceType,
							frameId: FRAME_ID,
						})
					}
				} else {
					this.event('Network.loadingFailed', {
						requestId: data.requestId,
						timestamp,
						type: meta?.resourceType ?? 'Fetch',
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
	onServeEvent(data: NetServeEvent): void {
		if (!this.enabled) return
		switch (data.ev) {
			case NetServeKind.Req: {
				const timestamp = data.timestamp
				const initiator = this.buildInitiator(data.callFrames)
				this.reqStartTimes.set(data.requestId, timestamp)
				this.reqMeta.set(data.requestId, {
					url: data.url,
					method: data.method,
					requestHeaders: data.headers,
					responseHeaders: {},
					status: 0,
					initiator,
					resourceType: 'Other',
				})
				this.event('Network.requestWillBeSent', {
					requestId: data.requestId,
					loaderId: LOADER_ID,
					documentURL: data.url,
					request: {
						url: data.url,
						method: data.method,
						headers: data.headers,
						hasPostData: data.postData != null,
						postData: data.postData ? this.truncateUtf8(data.postData, 1024) : undefined,
						initialPriority: 'High',
						referrerPolicy: 'no-referrer',
						isLinkPreload: false,
					},
					timestamp,
					wallTime: data.timestamp,
					initiator,
					hasExtraInfo: true,
					redirectHasExtraInfo: false,
					type: 'Other',
					frameId: FRAME_ID,
				})
				this.event('Network.requestWillBeSentExtraInfo', {
					requestId: data.requestId,
					associatedCookies: [],
					headers: data.headers,
					connectTiming: { requestTime: timestamp },
					siteHasCookieInOtherPartition: false,
				})
				break
			}
			case NetServeKind.Res: {
				const timestamp = data.timestamp
				const start = this.reqStartTimes.get(data.requestId) ?? timestamp
				const meta = this.reqMeta.get(data.requestId)
				if (meta) {
					meta.responseHeaders = data.headers
					meta.status = data.status
				}
				const requestHeaders = meta?.requestHeaders ?? {}
				const responseHeadersText = this.buildHeadersText(data.headers, data.status)
				const requestHeadersText = this.buildRequestHeadersText(meta?.method ?? 'GET', data.url, requestHeaders)
				this.event('Network.responseReceived', {
					requestId: data.requestId,
					loaderId: LOADER_ID,
					timestamp,
					type: 'Other',
					frameId: FRAME_ID,
					hasExtraInfo: true,
					response: {
						url: data.url,
						status: data.status,
						statusText: data.statusText ?? statusText(data.status),
						headers: data.headers,
						headersText: responseHeadersText,
						requestHeaders,
						requestHeadersText,
						mimeType: data.headers['content-type'] ?? data.headers['Content-Type'] ?? '',
						connectionReused: false,
						connectionId: 0,
						remoteIPAddress: '',
						remotePort: 0,
						fromDiskCache: false,
						fromServiceWorker: false,
						encodedDataLength: 0,
						protocol: 'http/1.1',
						securityState: data.url.startsWith('https:') ? 'secure' : 'neutral',
						timing: this.normalizeTiming(this.buildServeTiming(start, timestamp)),
					},
				})
				this.event('Network.responseReceivedExtraInfo', {
					requestId: data.requestId,
					blockedCookies: [],
					headers: data.headers,
					headersText: responseHeadersText,
					resourceIPAddressSpace: 'Unknown',
					statusCode: data.status,
					exemptedCookies: [],
				})
				break
			}
			case NetServeKind.Data: {
				const timestamp = data.timestamp
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
					timestamp,
					dataLength: data.byteLength,
					encodedDataLength: data.byteLength,
				})
				break
			}
			case NetServeKind.Done: {
				const timestamp = data.timestamp
				const entry = this.pendingBodies.get(data.requestId)
				this.pendingBodies.delete(data.requestId)
				if (entry) {
					if (this.responseBodyCache.size >= MAX_CACHED_BODIES) {
						const oldest = this.responseBodyCache.keys().next().value
						if (oldest !== undefined) this.responseBodyCache.delete(oldest)
					}
					this.responseBodyCache.set(data.requestId, entry)
				}
				if (data.success) {
					this.event('Network.loadingFinished', {
						requestId: data.requestId,
						timestamp,
						encodedDataLength: entry?.total ?? 0,
						shouldReportCorbBlocking: false,
					})
				} else {
					this.event('Network.loadingFailed', {
						requestId: data.requestId,
						timestamp,
						type: 'Other',
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

	onWSEvent(data: NetWSEvent): void {
		if (!this.enabled) return
		switch (data.ev) {
			case NetWSKind.Created:
				this.event('Network.webSocketCreated', {
					requestId: data.requestId,
					url: data.url,
					initiator: this.buildInitiator(data.callFrames),
				})
				if (data.requestHeaders) {
					const headers = this.headerEntriesToRecord(data.requestHeaders)
					this.event('Network.webSocketWillSendHandshakeRequest', {
						requestId: data.requestId,
						timestamp: data.timestamp,
						wallTime: data.timestamp,
						request: {
							headers,
							headersText: this.buildRequestHeadersText('GET', data.url, headers, 2),
						},
					})
				}
				break
			case NetWSKind.Handshake: {
				const timestamp = data.timestamp
				const hdrs: Record<string, string> = {}
				for (const [k, v] of data.headers) hdrs[k] = v
				this.event('Network.webSocketHandshakeResponseReceived', {
					requestId: data.requestId,
					timestamp,
					response: {
						status: data.status,
						statusText: statusText(data.status),
						headers: hdrs,
						headersText: this.headerBlock(hdrs),
						requestHeaders: {},
						requestHeadersText: '',
					},
				})
				break
			}
			case NetWSKind.Recv: {
				const timestamp = data.timestamp
				this.event('Network.webSocketFrameReceived', {
					requestId: data.requestId,
					timestamp,
					response: { opcode: data.opcode, mask: data.masked, payloadData: data.payloadData },
				})
				break
			}
			case NetWSKind.Sent: {
				const timestamp = data.timestamp
				this.event('Network.webSocketFrameSent', {
					requestId: data.requestId,
					timestamp,
					response: { opcode: data.opcode, mask: data.masked, payloadData: data.payloadData },
				})
				break
			}
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

		const phaseEnd = (duration: number | undefined): number =>
			duration != null ? Math.round(duration * 1000) : -1
		const debugMs = (epoch: number | undefined): number =>
			epoch != null ? Math.max(0, Math.round((epoch - start) * 1000)) : -1

		const dnsEndMs = phaseEnd(t.dnsDuration)
		if (dnsEndMs >= 0) { out.dnsStart = 0; out.dnsEnd = dnsEndMs }

		const connStartMs = dnsEndMs >= 0 ? dnsEndMs : 0
		const connEndMs = phaseEnd(t.connectDuration)
		if (connEndMs >= 0) { out.connectStart = connStartMs; out.connectEnd = connEndMs }

		const sslStartMs = connEndMs >= 0 ? connEndMs : connStartMs
		const sslEndMs = phaseEnd(t.sslDuration)
		if (sslEndMs >= 0 && sslEndMs > sslStartMs) { out.sslStart = sslStartMs; out.sslEnd = sslEndMs }

		const sendStartMs = sslEndMs >= 0 ? sslEndMs : connEndMs >= 0 ? connEndMs : 0
		const sendEndMs = phaseEnd(t.sendDuration)
		if (sendEndMs >= 0) { out.sendStart = sendStartMs; out.sendEnd = sendEndMs }
		const headerOutMs = debugMs(t.headerOutStart)
		if (headerOutMs >= 0) out.sendStart = headerOutMs
		const dataOutMs = debugMs(t.dataOutStart)
		if (dataOutMs >= 0) out.sendEnd = Math.max(out.sendStart >= 0 ? out.sendStart : dataOutMs, dataOutMs)

		const recvStartMs = phaseEnd(t.receiveHeadersDuration)
		if (recvStartMs >= 0) {
			out.receiveHeadersStart = sendEndMs >= 0 ? sendEndMs : recvStartMs
			out.receiveHeadersEnd = recvStartMs
		}
		const headerInMs = debugMs(t.headerInStart)
		if (headerInMs >= 0) {
			out.receiveHeadersStart = headerInMs
			if (out.receiveHeadersEnd < headerInMs) out.receiveHeadersEnd = headerInMs
		}

		// Content download: TTFB → transfer complete (CURLINFO_TOTAL_TIME).
		if (t.totalTime != null) {
			const contentEndMs = Math.round(t.totalTime * 1000)
			out.receiveContentStart = recvStartMs >= 0 ? recvStartMs : sendEndMs >= 0 ? sendEndMs : 0
			out.receiveContentEnd = contentEndMs
		}
		const dataInMs = debugMs(t.dataInStart)
		if (dataInMs >= 0) out.receiveContentStart = dataInMs

		return out
	}

	private buildServeTiming(start: number, responseTime: number): Record<string, number> {
		const headersMs = Math.max(0, Math.round((responseTime - start) * 1000))
		return {
			...EMPTY_TIMING,
			requestTime: start,
			sendStart: 0,
			sendEnd: 0,
			receiveHeadersStart: headersMs,
			receiveHeadersEnd: headersMs,
			receiveContentStart: headersMs,
		}
	}

	private normalizeTiming(timing: Record<string, number>): Record<string, number> {
		const out = { ...timing }

		// DevTools treats any truthy pushStart as HTTP/2 server push.
		// CNO does not surface pushed resources here, so keep the push lane disabled.
		out.pushStart = 0
		out.pushEnd = 0

		if (out.receiveHeadersEnd < 0 && out.receiveHeadersStart >= 0) out.receiveHeadersEnd = out.receiveHeadersStart
		if (out.receiveContentStart < 0 && out.receiveHeadersEnd >= 0) out.receiveContentStart = out.receiveHeadersEnd
		if (out.receiveContentEnd < 0 && out.receiveContentStart >= 0) out.receiveContentEnd = out.receiveContentStart

		return out
	}

	private buildInitiator(callFrames?: ConsoleCallFrame[]): Record<string, unknown> {
		const frames = this.filterCallFrames(callFrames)
		if (frames.length === 0) return { type: 'script' }
		return { type: 'script', stack: { callFrames: frames } }
	}

	private filterCallFrames(callFrames?: ConsoleCallFrame[]): ConsoleCallFrame[] {
		if (!callFrames) return []
		const frames: ConsoleCallFrame[] = []
		for (const frame of callFrames) {
			if (!frame || isInternalNetworkFrame(frame.url, frame.functionName)) continue
			frames.push(frame)
			if (frames.length >= 32) break
		}
		return frames
	}

	private buildHeadersText(headers: Record<string, string>, status: number, httpVersion?: number): string {
		// h2+ has no textual status line; HTTP/1.x uses version-specific line.
		if (httpVersion === 3 || httpVersion === 4 || httpVersion === 30) return this.headerBlock(headers)
		const proto = httpVersion === 1 ? 'HTTP/1.0' : 'HTTP/1.1'
		return `${proto} ${status} ${statusText(status)}\r\n` + this.headerBlock(headers)
	}

	private buildRequestHeadersText(method: string, url: string, headers: Record<string, string>, httpVersion?: number): string {
		const target = this.requestTarget(url)
		if (httpVersion === 3 || httpVersion === 4 || httpVersion === 30) return this.headerBlock(headers)
		const proto = httpVersion === 1 ? 'HTTP/1.0' : 'HTTP/1.1'
		return `${method} ${target} ${proto}\r\n` + this.headerBlock(headers)
	}

	private requestTarget(url: string): string {
		try {
			const u = new URL(url)
			return `${u.pathname || '/'}${u.search}`
		} catch {
			return url || '/'
		}
	}

	private headersTextToRecord(headersText: string | undefined, fallback: Record<string, string>): Record<string, string> {
		if (!headersText) return fallback
		const out: Record<string, string> = {}
		for (const line of headersText.split(/\r?\n/)) {
			if (!line || /^[A-Z]+ /.test(line) || /^HTTP\//i.test(line)) continue
			const colon = line.indexOf(':')
			if (colon <= 0) continue
			out[line.slice(0, colon).trim()] = line.slice(colon + 1).trim()
		}
		return Object.keys(out).length > 0 ? out : fallback
	}

	private headerEntriesToRecord(headers: Array<[string, string]>): Record<string, string> {
		const out: Record<string, string> = {}
		for (const [key, value] of headers) out[key] = value
		return out
	}

	private headerBlock(headers: Record<string, string>): string {
		let out = ''
		for (const key of Object.keys(headers)) out += `${key}: ${headers[key]}\r\n`
		return out + '\r\n'
	}

	private encodeBodyBase64(entry: BodyEntry): string {
		const body = new Uint8Array(entry.total)
		let offset = 0
		for (const chunk of entry.chunks) {
			body.set(chunk, offset)
			offset += chunk.byteLength
		}
		return nativeCrypto.base64Encode(body)
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
	pushStart: 0, pushEnd: 0,
	receiveHeadersStart: -1, receiveHeadersEnd: -1,
	receiveContentStart: -1, receiveContentEnd: -1,
}
