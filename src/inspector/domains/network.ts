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
import type { WorkerEndpoint } from '../transport/worker-endpoint'
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
	type NetworkSource,
} from '../shared/wire'

const engine = import.meta.use('engine');
const nativeCrypto = import.meta.use('crypto');
const curl = import.meta.use('curl');
const http = import.meta.use('http');
const os = import.meta.use('os');

const MAX_CACHED_BODIES = 200
const MAX_BODY_BYTES = 1024 * 1024 // 1 MiB
const DEFAULT_MAX_CACHED_BODY_BYTES = 128 * 1024 * 1024 // 128 MiB
const MAX_CACHED_REQUEST_BODIES = 200
const MAX_REQUEST_BODY_BYTES = 256 * 1024
const FETCH_FRAME_ID = 'cno-fetch-frame-1'
const FETCH_LOADER_ID = 'cno-fetch-loader-1'
const SERVE_FRAME_ID = 'cno-serve-frame-1'
const SERVE_LOADER_ID = 'cno-serve-loader-1'

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
	source: NetworkSource
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
	streamed?: boolean
	mimeType?: string
}

interface WSRequestMeta {
	source: NetworkSource
	url: string
	requestHeaders: Record<string, string>
	requestHeadersText: string
}

function protocolFromVersion(version?: number): string {
	switch (version) {
		case curl.CURL_HTTP_VERSION_3: 		return 'h3'
		case curl.CURL_HTTP_VERSION_2TLS:
		case curl.CURL_HTTP_VERSION_2_0: 	return 'h2'
		case curl.CURL_HTTP_VERSION_1_0: 	return 'http/1.0'
		case curl.CURL_HTTP_VERSION_1_1:
		default:							return 'http/1.1'
	}
}

function statusText(status: number): string {
	return http.strstatus(status) ?? 'OK';
}

export class NetworkDomain extends Domain {
	private enabled = false
	private cookies: Cookie[] = []
	private responseBodyCache = new Map<string, BodyEntry>()
	private responseBodyCacheBytes = 0
	private requestBodyCache = new Map<string, Uint8Array>()
	private pendingBodies = new Map<string, BodyEntry>()
	private streamedBodies = new Set<string>()
	private reqStartTimes = new Map<string, number>()
	private reqMeta = new Map<string, RequestMeta>()
	private wsMeta = new Map<string, WSRequestMeta>()
	/** Serve requestIds that are WS upgrades — suppress loadingFinished from HTTP side. */
	private wsUpgradeRequests = new Set<string>()
	private lastCleanupTime = 0

	constructor(dispatcher: CDPDispatcher, event: EmitEvent, private readonly rpc: WorkerEndpoint) {
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
			this.responseBodyCacheBytes = 0
			this.requestBodyCache.clear()
			this.streamedBodies.clear()
			this.wsMeta.clear()
			this.wsUpgradeRequests.clear()
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
		this.on('Network.streamResourceContent', async (p) => {
			const requestId = this.reqStr(p, 'requestId')
			const pending = this.pendingBodies.get(requestId)
			const bufferedData = pending ? nativeCrypto.base64Encode(this.mergeBody(pending)) : ''
			if (pending) {
				pending.streamed = true
				pending.chunks = []
				pending.total = 0
			}
			this.streamedBodies.add(requestId)
			await this.rpc.call('streamResourceContent', { requestId })
			return { bufferedData }
		})
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
			return this.encodeBody(entry)
		})
		this.on('Network.getRequestPostData', (p) => {
			const body = this.requestBodyCache.get(this.reqStr(p, 'requestId'))
			return { postData: body ? engine.decodeString(body) : '' }
		})
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
				this.cacheRequestBody(data.requestId, data.postData)
				this.reqStartTimes.set(data.requestId, timestamp)
				this.reqMeta.set(data.requestId, {
					source: data.source,
					url: data.url,
					method: data.method,
					requestHeaders: data.headers,
					responseHeaders: {},
					status: 0,
					initiator,
					resourceType,
				})
				const context = this.contextForSource(data.source)
				this.event('Network.requestWillBeSent', {
					requestId: data.requestId,
					loaderId: context.loaderId,
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
					frameId: context.frameId,
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
				const context = this.contextForSource(data.source)
				this.event('Network.responseReceived', {
					requestId: data.requestId,
					loaderId: context.loaderId,
					timestamp,
					type: resourceType,
					frameId: context.frameId,
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
						encodedDataLength: 0,
						protocol: protocolFromVersion(conn?.httpVersion),
						securityState: this.securityState(url, t?.sslVerifyResult),
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
					entry = { chunks: [], total: 0, truncated: false, mimeType: this.reqMeta.get(data.requestId)?.responseHeaders['content-type'] ?? this.reqMeta.get(data.requestId)?.responseHeaders['Content-Type'] }
					this.pendingBodies.set(data.requestId, entry)
				}
				if (!entry.streamed && entry.total + data.byteLength <= MAX_BODY_BYTES) {
					entry.chunks.push(data.data)
					entry.total += data.byteLength
				} else {
					entry.truncated = true
					entry.streamed = true
					this.streamedBodies.add(data.requestId)
				}
				const params: Record<string, unknown> = {
					requestId: data.requestId,
					timestamp,
					dataLength: data.byteLength,
					encodedDataLength: data.byteLength,
				}
				if (this.streamedBodies.has(data.requestId)) params.data = nativeCrypto.base64Encode(data.data)
				this.event('Network.dataReceived', params)
				break
			}
			case NetFetchKind.Done: {
				const timestamp = data.timestamp
				const meta = this.reqMeta.get(data.requestId)
				// Primary path: body arrives bundled in Done event (main-thread buffered).
				// Fallback: legacy per-chunk pendingBodies (if Data events were sent).
				const pendingEntry = this.pendingBodies.get(data.requestId)
				this.pendingBodies.delete(data.requestId)

				let bodyEntry: BodyEntry | undefined
				if (data.body && data.body.length > 0) {
					bodyEntry = {
						chunks: data.body,
						total: data.totalBytes ?? 0,
						truncated: false,
						mimeType: meta?.responseHeaders['content-type']
							?? meta?.responseHeaders['Content-Type'],
					}
				} else if (pendingEntry) {
					bodyEntry = pendingEntry
					if (!bodyEntry.mimeType && meta) {
						bodyEntry.mimeType = meta.responseHeaders['content-type']
							?? meta.responseHeaders['Content-Type']
					}
				}

				if (bodyEntry && !bodyEntry.streamed && !bodyEntry.truncated) this.cacheResponseBody(data.requestId, bodyEntry)
				const conn = data.connection
				if (data.success) {
					this.event('Network.loadingFinished', {
						requestId: data.requestId,
						timestamp,
						encodedDataLength: conn?.timing?.sizeDownload ?? conn?.downloadSize ?? bodyEntry?.total ?? 0,
						shouldReportCorbBlocking: false,
					})
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
				this.streamedBodies.delete(data.requestId)
				this.cleanupStaleEntries(timestamp)
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
				const initiator = this.buildServeInitiator(data.callFrames)
				const resourceType = this.classifyServeResourceType(data.url, data.method, data.headers)
				this.cacheRequestBody(data.requestId, data.postData)
				this.reqStartTimes.set(data.requestId, timestamp)
				this.reqMeta.set(data.requestId, {
					source: data.source,
					url: data.url,
					method: data.method,
					requestHeaders: data.headers,
					responseHeaders: {},
					status: 0,
					initiator,
					resourceType,
				})
				// WebSocket upgrades: skip HTTP events — the WS hook will emit
				// requestWillBeSent + webSocketCreated with the same requestId.
				// Emitting here would create a phantom "pending" entry that never
				// receives a responseReceived.
				if (resourceType !== 'WebSocket') {
					const context = this.contextForSource(data.source)
					this.event('Network.requestWillBeSent', {
						requestId: data.requestId,
						loaderId: context.loaderId,
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
						type: resourceType,
						frameId: context.frameId,
					})
					this.event('Network.requestWillBeSentExtraInfo', {
						requestId: data.requestId,
						associatedCookies: [],
						headers: data.headers,
						connectTiming: { requestTime: timestamp },
						siteHasCookieInOtherPartition: false,
					})
				}
				break
			}
			case NetServeKind.Res: {
				const timestamp = data.timestamp
				const start = this.reqStartTimes.get(data.requestId) ?? timestamp
				const meta = this.reqMeta.get(data.requestId)
				const resourceType = this.classifyServeResourceType(data.url, meta?.method ?? 'GET', meta?.requestHeaders ?? {}, data.headers)
				if (meta) {
					meta.responseHeaders = data.headers
					meta.status = data.status
					meta.resourceType = resourceType
				}
				// Detect WebSocket upgrade — mark so HTTP lifecycle doesn't close the entry.
				if (resourceType === 'WebSocket') {
					this.wsUpgradeRequests.add(data.requestId)
				}
				const requestHeaders = meta?.requestHeaders ?? {}
				const responseHeadersText = this.buildHeadersText(data.headers, data.status)
				const requestHeadersText = this.buildRequestHeadersText(meta?.method ?? 'GET', data.url, requestHeaders)
				const isWsUpgrade = this.wsUpgradeRequests.has(data.requestId)
				if (!isWsUpgrade) {
					const context = this.contextForSource(data.source)
					this.event('Network.responseReceived', {
						requestId: data.requestId,
						loaderId: context.loaderId,
						timestamp,
						type: resourceType,
						frameId: context.frameId,
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
				}
				break
			}
			case NetServeKind.Data: {
				const timestamp = data.timestamp
				let entry = this.pendingBodies.get(data.requestId)
				if (!entry) {
					entry = { chunks: [], total: 0, truncated: false, mimeType: this.reqMeta.get(data.requestId)?.responseHeaders['content-type'] ?? this.reqMeta.get(data.requestId)?.responseHeaders['Content-Type'] }
					this.pendingBodies.set(data.requestId, entry)
				}
				if (!entry.streamed && entry.total + data.byteLength <= MAX_BODY_BYTES) {
					entry.chunks.push(data.data)
					entry.total += data.byteLength
				} else {
					entry.truncated = true
					entry.streamed = true
					this.streamedBodies.add(data.requestId)
				}
				const params: Record<string, unknown> = {
					requestId: data.requestId,
					timestamp,
					dataLength: data.byteLength,
					encodedDataLength: data.byteLength,
				}
				if (this.streamedBodies.has(data.requestId)) params.data = nativeCrypto.base64Encode(data.data)
				this.event('Network.dataReceived', params)
				break
			}
			case NetServeKind.Done: {
				const timestamp = data.timestamp
				// Primary path: body arrives bundled in Done event (main-thread buffered).
				// Fallback: legacy per-chunk pendingBodies (if Data events were sent).
				const pendingEntry = this.pendingBodies.get(data.requestId)
				this.pendingBodies.delete(data.requestId)

				let bodyEntry: BodyEntry | undefined
				if (data.body && data.body.length > 0) {
					const serveMeta = this.reqMeta.get(data.requestId)
					bodyEntry = {
						chunks: data.body,
						total: data.totalBytes ?? 0,
						truncated: false,
						mimeType: serveMeta?.responseHeaders['content-type']
							?? serveMeta?.responseHeaders['Content-Type'],
					}
				} else if (pendingEntry) {
					bodyEntry = pendingEntry
					if (!bodyEntry.mimeType) {
						const serveMeta = this.reqMeta.get(data.requestId)
						if (serveMeta) {
							bodyEntry.mimeType = serveMeta.responseHeaders['content-type']
								?? serveMeta.responseHeaders['Content-Type']
						}
					}
				}

				if (bodyEntry && !bodyEntry.streamed && !bodyEntry.truncated) this.cacheResponseBody(data.requestId, bodyEntry)
				const isWsUpgrade = this.wsUpgradeRequests.has(data.requestId)
				if (isWsUpgrade) {
					// WebSocket upgrade: keep the entry alive for WS lifecycle events.
					// Don't emit loadingFinished — the WS Closed event will do it.
					// Don't delete reqMeta — WS events still reference it.
				} else if (data.success) {
					this.event('Network.loadingFinished', {
						requestId: data.requestId,
						timestamp,
						encodedDataLength: bodyEntry?.total ?? 0,
						shouldReportCorbBlocking: false,
					})
				} else {
					this.event('Network.loadingFailed', {
						requestId: data.requestId,
						timestamp,
						type: this.reqMeta.get(data.requestId)?.resourceType ?? 'Other',
						errorText: data.errorText ?? 'net::ERR_FAILED',
						canceled: false,
					})
				}
				if (!isWsUpgrade) {
					this.reqStartTimes.delete(data.requestId)
					this.reqMeta.delete(data.requestId)
				}
				this.streamedBodies.delete(data.requestId)
				this.cleanupStaleEntries(timestamp)
				break
			}
		}
	}

	onWSEvent(data: NetWSEvent): void {
		if (!this.enabled) return
		switch (data.ev) {
			case NetWSKind.Created:
				const wsHeaders = data.requestHeaders ? this.headerEntriesToRecord(data.requestHeaders) : {}
				this.wsMeta.set(data.requestId, {
					source: data.source,
					url: data.url,
					requestHeaders: wsHeaders,
					requestHeadersText: data.requestHeaders ? this.buildRequestHeadersText('GET', data.url, wsHeaders, data.source === 'fetch' ? 2 : undefined) : '',
				})
				this.reqStartTimes.set(data.requestId, data.timestamp)
				this.event('Network.webSocketCreated', {
					requestId: data.requestId,
					url: data.url,
					initiator: this.buildInitiatorForSource(data.source, data.callFrames),
				})
				if (data.requestHeaders) {
					const meta = this.wsMeta.get(data.requestId)
					const headers = meta?.requestHeaders ?? this.headerEntriesToRecord(data.requestHeaders)
					this.event('Network.webSocketWillSendHandshakeRequest', {
						requestId: data.requestId,
						timestamp: data.timestamp,
						wallTime: data.timestamp,
						request: {
							headers,
							headersText: meta?.requestHeadersText ?? this.buildRequestHeadersText('GET', data.url, headers, data.source === 'fetch' ? 2 : undefined),
						},
					})
				}
				break
			case NetWSKind.Handshake: {
				const timestamp = data.timestamp
				const hdrs: Record<string, string> = {}
				const meta = this.wsMeta.get(data.requestId)
				for (const [k, v] of data.headers) hdrs[k] = v
				const headersText = this.buildHeadersText(hdrs, data.status, data.source === 'fetch' ? 2 : undefined)
				this.event('Network.webSocketHandshakeResponseReceived', {
					requestId: data.requestId,
					timestamp,
					response: {
						status: data.status,
						statusText: statusText(data.status),
						headers: hdrs,
						headersText,
						requestHeaders: meta?.requestHeaders ?? {},
						requestHeadersText: meta?.requestHeadersText ?? '',
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
				if (data.code != null && data.code !== 1000) {
					this.event('Network.webSocketFrameError', {
						requestId: data.requestId,
						timestamp: data.timestamp,
						errorMessage: data.reason ? `WebSocket closed (${data.code}): ${data.reason}` : `WebSocket closed (${data.code})`,
					})
				}
				this.event('Network.webSocketClosed', { requestId: data.requestId, timestamp: data.timestamp })
				// Clean up WS upgrade tracking.
				if (this.wsUpgradeRequests.has(data.requestId)) {
					this.wsUpgradeRequests.delete(data.requestId)
					this.reqStartTimes.delete(data.requestId)
					this.reqMeta.delete(data.requestId)
				}
				this.wsMeta.delete(data.requestId)
				break
		}
	}

	private classifyServeResourceType(
		url: string,
		method: string,
		requestHeaders: Record<string, string>,
		responseHeaders?: Record<string, string>,
	): string {
		const req = this.lowerCaseHeaders(requestHeaders)
		const res = this.lowerCaseHeaders(responseHeaders ?? {})
		const upgrade = req['upgrade'] ?? ''
		if (upgrade.toLowerCase() === 'websocket') return 'WebSocket'
		if ((res['upgrade'] ?? '').toLowerCase() === 'websocket') return 'WebSocket'
		if (res['sec-websocket-accept']) return 'WebSocket'

		const secFetchDest = (req['sec-fetch-dest'] ?? '').toLowerCase()
		if (secFetchDest === 'document') return 'Document'
		if (secFetchDest === 'style') return 'Stylesheet'
		if (secFetchDest === 'script') return 'Script'
		if (secFetchDest === 'image') return 'Image'
		if (secFetchDest === 'font') return 'Font'
		if (secFetchDest === 'video' || secFetchDest === 'audio') return 'Media'
		if (secFetchDest === 'empty') return 'Other'

		const accept = req['accept'] ?? ''
		const mime = res['content-type'] ?? ''
		const probe = `${accept};${mime};${url}`.toLowerCase()
		if (/\btext\/html\b/.test(probe) || /\.(html?|xhtml)(?:[?#]|$)/.test(probe)) return 'Document'
		if (/\btext\/css\b/.test(probe) || /\.css(?:[?#]|$)/.test(probe)) return 'Stylesheet'
		if (/\b(?:application|text)\/(?:javascript|ecmascript)\b/.test(probe) || /\.(?:m?js|cjs|ts|mts|cts)(?:[?#]|$)/.test(probe)) return 'Script'
		if (/\bimage\//.test(probe) || /\.(?:png|jpe?g|gif|webp|svg|ico|bmp|avif)(?:[?#]|$)/.test(probe)) return 'Image'
		if (/\bfont\//.test(probe) || /\.(?:woff2?|ttf|otf|eot)(?:[?#]|$)/.test(probe)) return 'Font'
		if (/\b(?:audio|video)\//.test(probe) || /\.(?:mp4|webm|mp3|wav|ogg|m4a|mov)(?:[?#]|$)/.test(probe)) return 'Media'
		if (/\b(?:application\/json|application\/problem\+json|text\/json)\b/.test(probe)) return 'Other'
		return 'Other'
	}

	private lowerCaseHeaders(headers: Record<string, string>): Record<string, string> {
		const out: Record<string, string> = {}
		for (const key of Object.keys(headers)) out[key.toLowerCase()] = headers[key]
		return out
	}

	private cacheRequestBody(requestId: string, body?: Uint8Array): void {
		if (!body || body.byteLength === 0) return
		const slice = body.byteLength > MAX_REQUEST_BODY_BYTES ? body.subarray(0, MAX_REQUEST_BODY_BYTES) : body
		if (this.requestBodyCache.size >= MAX_CACHED_REQUEST_BODIES) {
			const oldest = this.requestBodyCache.keys().next().value
			if (oldest !== undefined) this.requestBodyCache.delete(oldest)
		}
		this.requestBodyCache.set(requestId, new Uint8Array(slice))
	}

	private cacheResponseBody(requestId: string, body: BodyEntry): void {
		const maxBytes = this.maxCachedBodyBytes()
		const existing = this.responseBodyCache.get(requestId)
		if (existing) this.responseBodyCacheBytes -= existing.total
		while (
			(this.responseBodyCache.size >= MAX_CACHED_BODIES || this.responseBodyCacheBytes + body.total > maxBytes)
			&& this.responseBodyCache.size > 0
		) {
			const oldest = this.responseBodyCache.keys().next().value
			if (oldest === undefined) break
			const removed = this.responseBodyCache.get(oldest)
			if (removed) this.responseBodyCacheBytes -= removed.total
			this.responseBodyCache.delete(oldest)
		}
		if (body.total > maxBytes) return
		this.responseBodyCache.set(requestId, body)
		this.responseBodyCacheBytes += body.total
	}

	private maxCachedBodyBytes(): number {
		const raw = this.getenv('CNO_INSPECTOR_BODY_CACHE_MAX_BYTES')
		if (!raw) return DEFAULT_MAX_CACHED_BODY_BYTES
		const parsed = Number(raw)
		return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : DEFAULT_MAX_CACHED_BODY_BYTES
	}

	private getenv(name: string): string | undefined {
		try { return os.getenv(name) ?? undefined } catch { return undefined }
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
		if (sendEndMs >= 0) {
			out.sendStart = sendStartMs
			out.sendEnd = Math.max(sendStartMs, sendEndMs)
		}
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
			out.receiveContentEnd = Math.max(out.receiveContentStart, contentEndMs)
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
		delete out.pushStart
		delete out.pushEnd

		if (out.dnsEnd >= 0 && out.dnsStart < 0) out.dnsStart = 0
		if (out.connectEnd >= 0) {
			if (out.connectStart < 0) out.connectStart = out.dnsEnd >= 0 ? out.dnsEnd : 0
			if (out.connectEnd < out.connectStart) out.connectEnd = out.connectStart
		}
		if (out.sslEnd >= 0) {
			if (out.sslStart < 0) out.sslStart = out.connectEnd >= 0 ? out.connectEnd : out.connectStart >= 0 ? out.connectStart : 0
			if (out.sslEnd < out.sslStart) out.sslEnd = out.sslStart
		}
		if (out.sendEnd >= 0) {
			if (out.sendStart < 0) out.sendStart = out.sslEnd >= 0 ? out.sslEnd : out.connectEnd >= 0 ? out.connectEnd : 0
			if (out.sendEnd < out.sendStart) out.sendEnd = out.sendStart
		}
		if (out.receiveHeadersStart >= 0 && out.sendEnd >= 0 && out.receiveHeadersStart < out.sendEnd) {
			out.receiveHeadersStart = out.sendEnd
		}
		if (out.receiveHeadersEnd < 0 && out.receiveHeadersStart >= 0) out.receiveHeadersEnd = out.receiveHeadersStart
		if (out.receiveHeadersEnd >= 0 && out.receiveHeadersStart >= 0 && out.receiveHeadersEnd < out.receiveHeadersStart) {
			out.receiveHeadersEnd = out.receiveHeadersStart
		}
		if (out.receiveContentStart < 0 && out.receiveHeadersEnd >= 0) out.receiveContentStart = out.receiveHeadersEnd
		if (out.receiveContentStart >= 0 && out.receiveHeadersEnd >= 0 && out.receiveContentStart < out.receiveHeadersEnd) {
			out.receiveContentStart = out.receiveHeadersEnd
		}
		if (out.receiveContentEnd < 0 && out.receiveContentStart >= 0) out.receiveContentEnd = out.receiveContentStart
		if (out.receiveContentEnd >= 0 && out.receiveContentStart >= 0 && out.receiveContentEnd < out.receiveContentStart) {
			out.receiveContentEnd = out.receiveContentStart
		}

		return out
	}

	private buildInitiator(callFrames?: ConsoleCallFrame[]): Record<string, unknown> {
		const frames = this.limitCallFrames(callFrames)
		if (frames.length === 0) return { type: 'script' }
		return { type: 'script', stack: { callFrames: frames } }
	}

	private buildServeInitiator(callFrames?: ConsoleCallFrame[]): Record<string, unknown> {
		const frames = this.limitCallFrames(callFrames)
		if (frames.length === 0) return { type: 'other' }
		return { type: 'other', stack: { callFrames: frames } }
	}

	private buildInitiatorForSource(source: NetworkSource, callFrames?: ConsoleCallFrame[]): Record<string, unknown> {
		return source === 'serve' ? this.buildServeInitiator(callFrames) : this.buildInitiator(callFrames)
	}

	private contextForSource(source: NetworkSource): { frameId: string; loaderId: string } {
		if (source === 'serve') {
			return { frameId: SERVE_FRAME_ID, loaderId: SERVE_LOADER_ID }
		}
		return { frameId: FETCH_FRAME_ID, loaderId: FETCH_LOADER_ID }
	}

	private limitCallFrames(callFrames?: ConsoleCallFrame[]): ConsoleCallFrame[] {
		if (!callFrames) return []
		const frames: ConsoleCallFrame[] = []
		for (const frame of callFrames) {
			if (!frame || (!frame.url && !frame.scriptId)) continue
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

	private encodeBody(entry: BodyEntry): { body: string; base64Encoded: boolean } {
		const body = this.mergeBody(entry)
		if (this.shouldTreatAsText(entry.mimeType, body)) {
			return { body: engine.decodeString(body), base64Encoded: false }
		}
		return { body: nativeCrypto.base64Encode(body), base64Encoded: true }
	}

	private mergeBody(entry: BodyEntry): Uint8Array {
		const body = new Uint8Array(entry.total)
		let offset = 0
		for (const chunk of entry.chunks) {
			body.set(chunk, offset)
			offset += chunk.byteLength
		}
		return body
	}

	private shouldTreatAsText(mimeType: string | undefined, body: Uint8Array): boolean {
		const mime = (mimeType ?? '').toLowerCase()
		const charset = mime.match(/(?:^|;)\s*charset\s*=\s*["']?([^;"'\s]+)/)?.[1]?.toLowerCase()
		if (charset && !/^(?:utf-?8|us-ascii|ascii)$/.test(charset)) return false
		if (mime.startsWith('text/')) return true
		if (/(?:^|\/)(json|xml|javascript|x-www-form-urlencoded)(?:$|[+;])/i.test(mime)) return true
		const sampleLen = Math.min(body.byteLength, 64)
		for (let i = 0; i < sampleLen; i++) {
			const ch = body[i]!
			if (ch === 0) return false
			if (ch < 0x09) return false
			if (ch > 0x0d && ch < 0x20) return false
		}
		return true
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

	private securityState(url: string, sslVerifyResult?: number): string {
		if (!url.startsWith('https:')) return 'neutral'
		if (sslVerifyResult == null) return 'unknown'
		return sslVerifyResult === 0 ? 'secure' : 'insecure'
	}

	/**
	 * Evict orphaned entries from reqMeta / pendingBodies / reqStartTimes.
	 * When Done events are lost (e.g. pipe saturation), these maps grow unbounded.
	 * Clean up entries older than 120 s.  Runs at most once every 30 s.
	 */
	private cleanupStaleEntries(now: number): void {
		if (now - this.lastCleanupTime < 30) return
		this.lastCleanupTime = now
		const cutoff = now - 120
		for (const [id, start] of this.reqStartTimes) {
			if (start < cutoff) {
				this.reqStartTimes.delete(id)
				this.reqMeta.delete(id)
				this.pendingBodies.delete(id)
				this.wsUpgradeRequests.delete(id)
			}
		}
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
	receiveHeadersStart: -1, receiveHeadersEnd: -1,
	receiveContentStart: -1, receiveContentEnd: -1,
}
