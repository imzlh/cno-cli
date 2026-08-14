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
import { CDPError, CdpErrorCode } from '../worker/dispatcher'
import { isRecord } from '../shared/cdp'
import type { CDPDispatcher, EmitEvent } from '../worker/dispatcher'
import type { WorkerEndpoint } from '../transport/worker-endpoint'
import {
	setUserAgentOverride,
	setExtraHTTPHeaders,
} from '../../../cno/src/utils/network-hooks'
import { getMemoryTier, getTierLimits } from '../../../cno/src/utils/memory-tier'
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

const tier = getTierLimits()
const MAX_CACHED_BODIES = { low: 20, normal: 100, high: 200 }[getMemoryTier()] ?? 100
const { inspectorPreviewBodyBytes: MAX_BODY_PREVIEW_BYTES } = tier
const BODY_PREVIEW_UNAVAILABLE = 'Content too large to display'
/** Cap on SearchMatch entries returned by Network.searchInResponseBody. */
const MAX_SEARCH_MATCHES = 1000
const MAX_CACHED_REQUEST_BODIES = { low: 20, normal: 100, high: 200 }[getMemoryTier()] ?? 100
const MAX_REQUEST_BODY_BYTES = { low: 16 * 1024, normal: 128 * 1024, high: 256 * 1024 }[getMemoryTier()] ?? 128 * 1024
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
	liveStreamed?: boolean
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
	private pendingBodyBytes = 0
	private streamedBodies = new Set<string>()
	private reqStartTimes = new Map<string, number>()
	private reqMeta = new Map<string, RequestMeta>()
	private wsMeta = new Map<string, WSRequestMeta>()
	/** Serve requestIds that are WS upgrades — suppress loadingFinished from HTTP side. */
	private wsUpgradeRequests = new Set<string>()
	/**
	 * requestIds for which THIS session already emitted requestWillBeSent. A
	 * request in flight when Network.enable arrives has no requestWillBeSent, so
	 * emitting its responseReceived/loadingFinished would hand DevTools terminal
	 * events for an id it never saw. Chrome/Node never report such a request at
	 * all. REASONED from the CDP event ordering contract.
	 */
	private announced = new Set<string>()
	/** Last time any event touched a requestId — drives staleness eviction. */
	private lastSeen = new Map<string, number>()
	private lastCleanupTime = 0

	/**
	 * Return to the detached state. `enabled`, the cookie jar and every
	 * requestId-keyed map are per-SESSION state in CDP: a second client must not
	 * inherit session 1's Network.enable, nor be able to read session 1's response
	 * bodies back out with getResponseBody. Mirrors FetchDomain.setConnected.
	 */
	setConnected(connected: boolean): void {
		if (connected) return
		this.enabled = false
		this.clearState()
	}

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
			this.clearState()
			return {}
		})
		this.on('Network.setUserAgentOverride', (p) => {
			// `userAgent` is required. A wrong-typed value used to read as
			// undefined and CLEAR a previously-installed override while
			// reporting success — a destructive no-op on malformed input.
			if (typeof p.userAgent !== 'string') {
				throw new CDPError(CdpErrorCode.InvalidParams, "CDP param 'userAgent' is required")
			}
			setUserAgentOverride(p.userAgent || null)
			return {}
		})
		this.on('Network.setExtraHTTPHeaders', (p) => {
			// `headers` is required by the CDP spec. Missing or wrong-typed used to
			// degrade to `{}` and silently WIPE any override a previous call had
			// installed, while answering {} as though it had succeeded.
			if (!isRecord(p.headers)) {
				throw new CDPError(CdpErrorCode.InvalidParams, "CDP param 'headers' is required")
			}
			// Non-string VALUES inside a well-formed record stay best-effort: they
			// are skipped, not rejected.
			setExtraHTTPHeaders(this.stringHeadersFromRecord(p.headers))
			return {}
		})
		this.on('Network.canEmulateNetworkConditions', () => ({ result: false }))
		this.on('Network.emulateNetworkConditions', (p) => {
			// canEmulateNetworkConditions answers `false` in this same domain, so
			// answering {} here claimed to have applied throttling that this runtime
			// cannot apply. Required params are validated; a request that asks for
			// NO throttling is honoured as a genuine no-op, because "unthrottled" is
			// the state cno is actually in. A request for real emulation is refused
			// rather than silently ignored.
			if (typeof p.offline !== 'boolean') {
				throw new CDPError(CdpErrorCode.InvalidParams, "CDP param 'offline' is required")
			}
			for (const key of ['latency', 'downloadThroughput', 'uploadThroughput'] as const) {
				if (typeof p[key] !== 'number') {
					throw new CDPError(CdpErrorCode.InvalidParams, `CDP param '${key}' is required`)
				}
			}
			const wantsEmulation = p.offline === true
				|| (p.latency as number) > 0
				|| (p.downloadThroughput as number) > 0
				|| (p.uploadThroughput as number) > 0
			if (wantsEmulation) {
				throw new CDPError(CdpErrorCode.InvalidParams, 'Network emulation is not supported')
			}
			return {}
		})
		this.on('Network.setCacheDisabled', () => ({}))
		this.on('Network.setBypassServiceWorker', () => ({}))
		this.on('Network.setAcceptedEncodings', () => ({}))
		this.on('Network.clearAcceptedEncodingsOverride', () => ({}))
		this.on('Network.setAttachDebugStack', () => ({}))
		this.on('Network.replayXHR', () => ({}))
		this.on('Network.streamResourceContent', async (p) => {
			const requestId = this.reqStr(p, 'requestId')
			// MEASURED against node v24.18: streaming an id that was never seen
			// answers -32602 "Request not found". Previously this fell through and
			// RPC'd the main thread for a request that does not exist.
			if (!this.announced.has(requestId)) {
				throw new CDPError(CdpErrorCode.InvalidParams, 'Request not found')
			}
			const pending = this.pendingBodies.get(requestId)
			const workerData = pending && pending.total > 0
				? this.copyBytes(this.mergeBody(pending))
				: new Uint8Array(0)
			this.enableLiveStreamingForRequest(requestId, false)
			const reply = await this.rpc.call('streamResourceContent', {
				requestId,
				source: this.reqMeta.get(requestId)?.source,
			})
			const mainData = isRecord(reply) && reply.bufferedData instanceof Uint8Array
				? reply.bufferedData
				: new Uint8Array(0)
			const buffered = mainData.byteLength > 0 && workerData.byteLength > 0
				? this.mergeChunks([mainData, workerData])
				: mainData.byteLength > 0 ? mainData : workerData
			const bufferedData = buffered.byteLength > 0 ? nativeCrypto.base64Encode(buffered) : ''
			return { bufferedData }
		})
		/**
		 * Search a cached response body. This used to be `() => ({ result: [] })`,
		 * which ignored every parameter and so reported "no matches" for a string
		 * the cached body demonstrably contained — a wrong answer on valid input,
		 * not merely an unimplemented one. It also fabricated a successful empty
		 * search for an id that never existed, contradicting the standard
		 * getResponseBody applies ~30 lines below.
		 *
		 * Shape follows CDP `SearchMatch[]`: one entry per matching LINE, with a
		 * 0-based lineNumber, as Chrome reports it.
		 */
		this.on('Network.searchInResponseBody', (p) => {
			const requestId = this.reqStr(p, 'requestId')
			const query = this.reqStr(p, 'query')
			const entry = this.responseBodyCache.get(requestId)
			// Same standard as getResponseBody: an unknown or already-evicted id is
			// an error, not an empty result set.
			if (!entry) {
				throw new CDPError(CdpErrorCode.InvalidParams, 'Request not found')
			}
			// A truncated entry holds no bytes — only the "too large" placeholder.
			// Answering `[]` would claim a search of content we never had, and
			// searching the placeholder text would invent matches. Say so instead.
			if (entry.truncated) {
				throw new CDPError(CdpErrorCode.InvalidParams, BODY_PREVIEW_UNAVAILABLE)
			}
			const caseSensitive = p.caseSensitive === true
			const isRegex = p.isRegex === true
			let matches: (line: string) => boolean
			if (isRegex) {
				let re: RegExp
				// A client-supplied pattern can be invalid; that is InvalidParams,
				// not an internal error. No 'm' flag: each line is tested on its
				// own, so ^/$ already anchor per line.
				try {
					re = new RegExp(query, caseSensitive ? '' : 'i')
				} catch {
					throw new CDPError(CdpErrorCode.InvalidParams, 'Invalid regular expression')
				}
				matches = (line) => { re.lastIndex = 0; return re.test(line) }
			} else {
				const needle = caseSensitive ? query : query.toLowerCase()
				matches = (line) => (caseSensitive ? line : line.toLowerCase()).includes(needle)
			}
			const text = engine.decodeString(this.mergeBody(entry))
			const result: Array<{ lineNumber: number; lineContent: string }> = []
			const lines = text.split('\n')
			for (let i = 0; i < lines.length; i++) {
				// An empty query, or a regex like `.*`, matches every line; cap the
				// answer so one command cannot serialize the whole body back line
				// by line. The body is already capped, so this is a serialization
				// bound, not a correctness one.
				if (result.length >= MAX_SEARCH_MATCHES) break
				let line = lines[i] ?? ''
				if (line.endsWith('\r')) line = line.slice(0, -1)
				if (matches(line)) result.push({ lineNumber: i, lineContent: line })
			}
			return { result }
		})

		// Cookies.
		this.on('Network.getCookies', () => ({ cookies: this.cookies }))
		this.on('Network.getAllCookies', () => ({ cookies: this.cookies }))
		this.on('Network.deleteCookies', (p) => {
			// `name` is required. Missing used to read as undefined, so the filter
			// `c.name !== undefined` kept every cookie and the command answered {}:
			// a client that deleted a cookie and saw success still had it.
			const name = this.reqStr(p, 'name')
			this.cookies = this.cookies.filter((c) => c.name !== name)
			return {}
		})
		this.on('Network.clearBrowserCookies', () => {
			this.cookies = []
			return {}
		})
		this.on('Network.setCookie', (p) => {
			// `name` and `value` are both required. They used to default to '', so
			// `setCookie {}` stored an empty-name cookie — observable afterwards via
			// getCookies — and answered {success:true}, an explicit claim.
			this.reqStr(p, 'name')
			this.reqStr(p, 'value')
			this.cookies.push(this.makeCookie(p))
			return { success: true }
		})
		this.on('Network.setCookies', (p) => {
			// `cookies` is required and must be an array. A wrong-typed value used
			// to degrade to [] and answer {}, storing nothing while reporting that
			// the whole batch had been set. Malformed ENTRIES inside a well-formed
			// array stay best-effort — they are skipped, not rejected.
			if (!Array.isArray(p.cookies)) {
				throw new CDPError(CdpErrorCode.InvalidParams, "CDP param 'cookies' is required")
			}
			for (const c of p.cookies.filter(isRecord)) this.cookies.push(this.makeCookie(c))
			return {}
		})
		this.on('Network.clearBrowserCache', () => ({}))

		// Bodies.
		this.on('Network.getResponseBody', (p) => {
			const requestId = this.reqStr(p, 'requestId')
			const entry = this.responseBodyCache.get(requestId)
			// A requestId we never saw, or whose body was already evicted, is an
			// error — not an empty body. Returning `{body:''}` made a released or
			// bogus id indistinguishable from a genuinely empty 204 body.
			// MEASURED against node v24.18 (`inspector.Session`):
			//   Network.getResponseBody {requestId:'never-existed'}
			//     -> -32602 "Request not found"
			if (!entry) {
				throw new CDPError(CdpErrorCode.InvalidParams, 'Request not found')
			}
			if (entry.truncated) return { body: BODY_PREVIEW_UNAVAILABLE, base64Encoded: false }
			return this.encodeBody(entry)
		})
		this.on('Network.getRequestPostData', (p) => {
			const requestId = this.reqStr(p, 'requestId')
			const body = this.requestBodyCache.get(requestId)
			// MEASURED against node v24.18: -32602 "Request not found".
			if (!body) {
				throw new CDPError(CdpErrorCode.InvalidParams, 'Request not found')
			}
			return { postData: engine.decodeString(body) }
		})
	}

	private clearState(): void {
		this.cookies = []
		this.reqStartTimes.clear()
		this.reqMeta.clear()
		this.pendingBodies.clear()
		this.pendingBodyBytes = 0
		this.responseBodyCache.clear()
		this.responseBodyCacheBytes = 0
		this.requestBodyCache.clear()
		this.streamedBodies.clear()
		this.wsMeta.clear()
		this.wsUpgradeRequests.clear()
		this.announced.clear()
		this.lastSeen.clear()
	}

	private stringHeadersFromRecord(value: unknown): Record<string, string> {
		const rawHeaders = isRecord(value) ? value : {}
		const headers: Record<string, string> = {}
		for (const [name, rawValue] of Object.entries(rawHeaders)) {
			if (typeof rawValue === 'string') headers[name] = rawValue
		}
		return headers
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
				this.announced.add(data.requestId)
				this.lastSeen.set(data.requestId, timestamp)
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
				// Staleness eviction used to be reachable ONLY from
				// handleNetworkDoneEvent, so a workload in which nothing completes
				// never reclaimed anything and every requestId-keyed map grew for
				// the process lifetime (OBSERVED: 1000 abandoned requests retained
				// 5000 entries, 5000 retained 25000 — linear, zero decay). Drive
				// the tick from the REQUEST path, where the growth happens.
				// cleanupStaleEntries is internally throttled to once per 30 s, so
				// this costs one subtraction per request in the common case.
				this.cleanupStaleEntries(timestamp)
				break
			}
			case NetFetchKind.Res: {
				if (!this.announced.has(data.requestId)) return
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
						mimeType: t?.contentType ?? this.headerValue(data.headers, 'content-type') ?? '',
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
				this.handleNetworkDataEvent(data)
				break
			}
			case NetFetchKind.Done: {
				this.handleNetworkDoneEvent(data.source, data)
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
				if (resourceType === 'WebSocket') {
					this.wsUpgradeRequests.add(data.requestId)
					this.lastSeen.set(data.requestId, timestamp)
				} else {
					this.announced.add(data.requestId)
					this.lastSeen.set(data.requestId, timestamp)
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
				// Same reason as the fetch Req path: eviction must not depend on
				// some other request completing.
				this.cleanupStaleEntries(timestamp)
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
				if (!isWsUpgrade && this.announced.has(data.requestId)) {
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
							mimeType: this.headerValue(data.headers, 'content-type') ?? '',
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
				this.handleNetworkDataEvent(data)
				break
			}
			case NetServeKind.Done: {
				this.handleNetworkDoneEvent(data.source, data)
				break
			}
		}
	}

	onWSEvent(data: NetWSEvent): void {
		if (!this.enabled) return
		this.lastSeen.set(data.requestId, data.timestamp)
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
				this.announced.add(data.requestId)
				this.lastSeen.set(data.requestId, data.timestamp)
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
				// Release every map this id can appear in, UNCONDITIONALLY.
				// NetWSKind.Created sets reqStartTimes for every websocket, but this
				// release used to be guarded by `wsUpgradeRequests.has(id)`, and that
				// set is populated only by the serve-side HTTP-upgrade path. A CLIENT
				// websocket (`new WebSocket()`, source 'fetch') therefore never took
				// the branch and leaked one permanent reqStartTimes entry per closed
				// connection (OBSERVED: 1000 open/close cycles -> 1000 entries, 5000
				// -> 5000). The id was then invisible to the first cleanup loop, which
				// iterates lastSeen, and reclaimable only by the second — which ran
				// only on an HTTP Done, and a pure-websocket workload has none.
				// Deleting an absent key is a no-op, so the serve path is unaffected.
				this.wsUpgradeRequests.delete(data.requestId)
				this.reqStartTimes.delete(data.requestId)
				this.reqMeta.delete(data.requestId)
				this.wsMeta.delete(data.requestId)
				this.announced.delete(data.requestId)
				this.lastSeen.delete(data.requestId)
				break
		}
		// A websocket-only workload emits no HTTP Done at all, so without this the
		// second cleanup loop never runs for ids that were created and never closed.
		this.cleanupStaleEntries(data.timestamp)
	}

	// ── shared body buffering (used by both fetch and serve) ───────
	private handleNetworkDataEvent(data: { requestId: string; timestamp: number; data: Uint8Array; byteLength: number }): void {
		// No requestWillBeSent for this id in this session → DevTools would get a
		// dataReceived for an unknown request. Also avoids buffering a body that
		// getResponseBody must never hand back.
		if (!this.announced.has(data.requestId)) return
		this.lastSeen.set(data.requestId, data.timestamp)
		let entry = this.pendingBodies.get(data.requestId)
		if (!entry) {
			entry = {
				chunks: [],
				total: 0,
				truncated: false,
				liveStreamed: this.streamedBodies.has(data.requestId),
				mimeType: this.headerValue(this.reqMeta.get(data.requestId)?.responseHeaders, 'content-type'),
			}
			this.pendingBodies.set(data.requestId, entry)
		}
		if (entry.liveStreamed) {
			// Live bytes are carried on dataReceived below and need no second copy.
		} else if (!entry.truncated && this.shouldBufferResponseBody(data.requestId) && entry.total + data.byteLength <= MAX_BODY_PREVIEW_BYTES && this.ensurePendingBodyCapacity(data.requestId, data.byteLength)) {
			const chunk = this.copyBytes(data.data)
			entry.chunks.push(chunk)
			entry.total += chunk.byteLength
			this.pendingBodyBytes += chunk.byteLength
		} else {
			this.dropBufferedBodyForRequest(data.requestId)
			entry.truncated = true
		}
		const params: Record<string, unknown> = {
			requestId: data.requestId,
			timestamp: data.timestamp,
			dataLength: data.byteLength,
			encodedDataLength: data.byteLength,
		}
		if (this.streamedBodies.has(data.requestId)) params.data = nativeCrypto.base64Encode(new Uint8Array(data.data))
		this.event('Network.dataReceived', params)
	}

	private handleNetworkDoneEvent(
		source: NetworkSource,
		data: { requestId: string; timestamp: number; success: boolean; errorText?: string; body?: Uint8Array[]; totalBytes?: number; connection?: FetchConnection },
	): void {
		const announced = this.announced.has(data.requestId)
		const meta = this.reqMeta.get(data.requestId)
		const pendingEntry = this.pendingBodies.get(data.requestId)
		this.dropPendingBody(data.requestId)
		// Unannounced (started before Network.enable, or belonging to a previous
		// session): emit nothing, but still release every map keyed by this id so a
		// request that spans an enable boundary cannot leak.
		if (!announced) {
			this.reqStartTimes.delete(data.requestId)
			this.reqMeta.delete(data.requestId)
			this.streamedBodies.delete(data.requestId)
			this.wsUpgradeRequests.delete(data.requestId)
			this.lastSeen.delete(data.requestId)
			this.cleanupStaleEntries(data.timestamp)
			return
		}
		let bodyEntry: BodyEntry | undefined
		if (data.body && data.body.length > 0) {
			const merged = this.mergeChunks(data.body)
			bodyEntry = {
				chunks: [merged],
				total: merged.byteLength,
				truncated: false,
				mimeType: this.headerValue(meta?.responseHeaders, 'content-type'),
			}
		} else if (pendingEntry) {
			bodyEntry = pendingEntry
			if (!bodyEntry.mimeType && meta) {
				bodyEntry.mimeType = this.headerValue(meta.responseHeaders, 'content-type')
			}
		}

		if (bodyEntry && this.shouldBufferResponseBody(data.requestId)) {
			if (bodyEntry.liveStreamed) {
				// Live-streamed bodies were already sent via dataReceived;
				// nothing to cache.
			} else if (!bodyEntry.truncated) {
				this.cacheResponseBody(data.requestId, bodyEntry)
			} else {
				this.cacheUnavailableResponseBody(data.requestId, bodyEntry.mimeType)
			}
		}
		const isWsUpgrade = this.wsUpgradeRequests.has(data.requestId)
		if (!isWsUpgrade) {
			if (data.success) {
				const encodedDataLength = source === 'fetch'
					? (data.connection?.timing?.sizeDownload ?? data.connection?.downloadSize ?? data.totalBytes ?? bodyEntry?.total ?? 0)
					: (bodyEntry?.total ?? 0)
				this.event('Network.loadingFinished', {
					requestId: data.requestId,
					timestamp: data.timestamp,
					encodedDataLength,
					shouldReportCorbBlocking: false,
				})
			} else {
				this.event('Network.loadingFailed', {
					requestId: data.requestId,
					timestamp: data.timestamp,
					type: meta?.resourceType ?? 'Other',
					errorText: data.errorText ?? 'net::ERR_FAILED',
					canceled: false,
				})
			}
			this.reqStartTimes.delete(data.requestId)
			this.reqMeta.delete(data.requestId)
			this.announced.delete(data.requestId)
			this.lastSeen.delete(data.requestId)
		}
		this.streamedBodies.delete(data.requestId)
		this.cleanupStaleEntries(data.timestamp)
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

	private shouldBufferResponseBody(requestId: string): boolean {
		const resourceType = this.reqMeta.get(requestId)?.resourceType
		return resourceType !== 'WebSocket'
	}

	private dropPendingBody(requestId: string): void {
		const entry = this.pendingBodies.get(requestId)
		if (!entry) return
		this.pendingBodyBytes = Math.max(0, this.pendingBodyBytes - entry.total)
		this.pendingBodies.delete(requestId)
	}

	private dropBufferedBodyForRequest(requestId: string): void {
		const entry = this.pendingBodies.get(requestId)
		if (entry) {
			entry.truncated = true
			entry.chunks = []
			this.pendingBodyBytes = Math.max(0, this.pendingBodyBytes - entry.total)
			entry.total = 0
		}
	}

	private enableLiveStreamingForRequest(requestId: string, syncMain = true): void {
		const alreadyStreaming = this.streamedBodies.has(requestId)
		this.streamedBodies.add(requestId)
		this.dropPendingBody(requestId)
		if (syncMain && !alreadyStreaming) this.rpc.notify('streamResourceContent', { requestId, source: this.reqMeta.get(requestId)?.source })
	}

	private ensurePendingBodyCapacity(requestId: string, incomingBytes: number): boolean {
		const maxBytes = MAX_BODY_PREVIEW_BYTES / 2;
		// A single chunk bigger than the whole eviction budget can never be made to
		// fit, so evicting other requests' buffers would discard them for nothing.
		if (incomingBytes > maxBytes) {
			this.dropBufferedBodyForRequest(requestId)
			return false
		}
		// Evict oldest-first. `dropBufferedBodyForRequest` zeroes an entry but keeps
		// its key (the request is still live and its Done event must still find it),
		// so this MUST iterate rather than re-reading the map head: re-reading spins
		// forever the moment the head entry has nothing left to reclaim.
		for (const candidate of this.pendingBodies.keys()) {
			if (this.pendingBodyBytes + incomingBytes <= maxBytes) break
			if (candidate === requestId) continue
			const entry = this.pendingBodies.get(candidate)
			if (!entry || entry.total === 0) continue
			this.dropBufferedBodyForRequest(candidate)
		}
		if (this.pendingBodyBytes + incomingBytes <= maxBytes) return true
		this.dropBufferedBodyForRequest(requestId)
		return false
	}

	private cacheUnavailableResponseBody(requestId: string, mimeType?: string): void {
		const existing = this.responseBodyCache.get(requestId)
		if (existing) this.responseBodyCacheBytes -= existing.total
		this.responseBodyCache.delete(requestId)
		while (this.responseBodyCache.size >= MAX_CACHED_BODIES && this.responseBodyCache.size > 0) {
			const oldest = this.responseBodyCache.keys().next().value
			if (oldest === undefined) break
			const removed = this.responseBodyCache.get(oldest)
			if (removed) this.responseBodyCacheBytes -= removed.total
			this.responseBodyCache.delete(oldest)
		}
		this.responseBodyCache.set(requestId, { chunks: [], total: 0, truncated: true, mimeType })
	}

	private cacheResponseBody(requestId: string, body: BodyEntry): void {
		const existing = this.responseBodyCache.get(requestId)
		if (existing) this.responseBodyCacheBytes -= existing.total
		while (
			(this.responseBodyCache.size >= MAX_CACHED_BODIES || this.responseBodyCacheBytes + body.total > MAX_BODY_PREVIEW_BYTES)
			&& this.responseBodyCache.size > 0
		) {
			const oldest = this.responseBodyCache.keys().next().value
			if (oldest === undefined) break
			const removed = this.responseBodyCache.get(oldest)
			if (removed) this.responseBodyCacheBytes -= removed.total
			this.responseBodyCache.delete(oldest)
		}
		if (body.total > MAX_BODY_PREVIEW_BYTES) {
			this.cacheUnavailableResponseBody(requestId, body.mimeType)
			return
		}
		this.responseBodyCache.set(requestId, body)
		this.responseBodyCacheBytes += body.total
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
		return this.scriptInitiator(frames)
	}

	private buildServeInitiator(callFrames?: ConsoleCallFrame[]): Record<string, unknown> {
		const frames = this.limitCallFrames(callFrames)
		if (frames.length === 0) return { type: 'other' }
		return this.scriptInitiator(frames)
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

	private scriptInitiator(frames: ConsoleCallFrame[]): Record<string, unknown> {
		const top = frames[0]
		return {
			type: 'script',
			url: top?.url || top?.scriptId || '',
			lineNumber: top?.lineNumber ?? 0,
			columnNumber: top?.columnNumber ?? 0,
			stack: { callFrames: frames },
		}
	}

	private buildHeadersText(headers: Record<string, string>, status: number, httpVersion?: number): string {
		// h2+ has no textual status line; HTTP/1.x uses version-specific line.
		if (this.isHeaderBlockOnlyVersion(httpVersion)) return this.headerBlock(headers)
		const proto = httpVersion === 1 ? 'HTTP/1.0' : 'HTTP/1.1'
		return `${proto} ${status} ${statusText(status)}\r\n` + this.headerBlock(headers)
	}

	private buildRequestHeadersText(method: string, url: string, headers: Record<string, string>, httpVersion?: number): string {
		const target = this.requestTarget(url)
		if (this.isHeaderBlockOnlyVersion(httpVersion)) return this.headerBlock(headers)
		const proto = httpVersion === 1 ? 'HTTP/1.0' : 'HTTP/1.1'
		return `${method} ${target} ${proto}\r\n` + this.headerBlock(headers)
	}

	private isHeaderBlockOnlyVersion(httpVersion?: number): boolean {
		return httpVersion === 3 || httpVersion === 4 || httpVersion === 30
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

	private headerValue(headers: Record<string, string> | undefined, name: string): string | undefined {
		if (!headers) return undefined
		const lowerName = name.toLowerCase()
		for (const key of Object.keys(headers)) {
			if (key.toLowerCase() === lowerName) return headers[key]
		}
		return undefined
	}

	private encodeBody(entry: BodyEntry): { body: string; base64Encoded: boolean } {
		const body = this.mergeBody(entry)
		if (this.shouldTreatAsText(entry.mimeType, body)) {
			return { body: engine.decodeString(body), base64Encoded: false }
		}
		return { body: nativeCrypto.base64Encode(new Uint8Array(body)), base64Encoded: true }
	}

	private mergeBody(entry: BodyEntry): Uint8Array {
		return this.mergeChunks(entry.chunks, entry.total)
	}

	private mergeChunks(chunks: Uint8Array[], totalBytes?: number): Uint8Array {
		const total = totalBytes ?? chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0)
		const body = new Uint8Array(total)
		let offset = 0
		for (const chunk of chunks) {
			body.set(chunk, offset)
			offset += chunk.byteLength
		}
		return body
	}

	private copyBytes(data: Uint8Array): Uint8Array {
		const copy = new Uint8Array(data.byteLength)
		copy.set(data)
		return copy
	}

	private shouldTreatAsText(mimeType: string | undefined, body: Uint8Array): boolean {
		const mime = (mimeType ?? '').toLowerCase()
		const charset = mime.match(/(?:^|;)\s*charset\s*=\s*["']?([^;"'\s]+)/)?.[1]?.toLowerCase()
		if (charset && !/^(?:utf-?8|us-ascii|ascii)$/.test(charset)) return false
		if (mime.startsWith('text/')) return true
		if (/(?:^|\/)(json|xml|javascript|x-www-form-urlencoded)(?:$|[+;])/i.test(mime)) return true
		const sampleLen = Math.min(body.byteLength, 64)
		for (let i = 0; i < sampleLen; i++) {
			const ch = body[i]
			if (ch === undefined) continue
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
	 * Evict orphaned entries from every requestId-keyed map.
	 * When Done events are lost (e.g. pipe saturation) or a request is aborted
	 * without a terminal event, these maps grow unbounded. Clean up entries
	 * untouched for 120 s. Runs at most once every 30 s.
	 *
	 * Keyed on `lastSeen` (last event for the id), NOT the start time: a download
	 * or a WebSocket that legitimately runs longer than 120 s must not have its
	 * metadata evicted mid-flight, which would strand its body and make its
	 * terminal event unannounced.
	 */
	private cleanupStaleEntries(now: number): void {
		if (now - this.lastCleanupTime < 30) return
		this.lastCleanupTime = now
		const cutoff = now - 120
		for (const [id, seen] of this.lastSeen) {
			if (seen >= cutoff) continue
			this.lastSeen.delete(id)
			this.reqStartTimes.delete(id)
			this.reqMeta.delete(id)
			this.dropPendingBody(id)
			this.streamedBodies.delete(id)
			this.wsUpgradeRequests.delete(id)
			this.wsMeta.delete(id)
			this.announced.delete(id)
		}
		// Ids that never made it into lastSeen (or outlived it) must not pin memory.
		for (const [id, start] of this.reqStartTimes) {
			if (start < cutoff && !this.lastSeen.has(id)) {
				this.reqStartTimes.delete(id)
				this.reqMeta.delete(id)
				this.dropPendingBody(id)
				this.streamedBodies.delete(id)
				this.wsUpgradeRequests.delete(id)
				this.wsMeta.delete(id)
				this.announced.delete(id)
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
