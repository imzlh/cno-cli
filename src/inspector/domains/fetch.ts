/**
 * domains/fetch.ts — Fetch CDP domain (worker thread).
 *
 * Implements request interception. cno's native fetch-intercept hook fires for
 * each request; if a DevTools pattern matches we pause the request (emit
 * Fetch.requestPaused) and hold a resolver. continue/fulfill/fail later send an
 * `InterceptResult` back to native over the inspect transport. Anything we
 * don't intercept is resolved with `null` (proceed unchanged) immediately.
 */

import { Domain } from './base'
import type { CDPDispatcher, EmitEvent } from '../worker/dispatcher'
import type { WorkerEndpoint } from '../transport/worker-endpoint'
import type { FetchInterceptPayload } from '../shared/wire'
import type { InterceptResult } from '../../../cno/src/utils/network-hooks'
import { isRecord } from '../shared/cdp'
import type {
	FetchContinueRequestParams,
	FetchFulfillRequestParams,
	FetchFailRequestParams,
	FetchContinueResponseParams,
} from '../shared/cdp'

const nativeCrypto = import.meta.use('crypto');

interface Pattern {
	matchUrl: (url: string) => boolean
	resourceType?: string
}

interface HeaderEntry {
	name: string
	value: string
}

/**
 * Compile a CDP `Fetch.RequestPattern.urlPattern` into a matcher.
 *
 * Deliberately NOT a regex. Every '*' compiles to '.*', so `*a*a*a…` becomes a
 * chain of adjacent '.*' groups and a URL that almost matches backtracks
 * catastrophically. MEASURED on the previous regex implementation (node v24.18,
 * identical compiled source): 4 wildcards 8.8ms, 8 wildcards 70,741ms, 20
 * wildcards did not finish in 60s — and the only guard was a 256-char pattern cap
 * that none of these came close to. A user typing `*a*a*b` into DevTools' network
 * filter wedged the debug worker with no error shown.
 *
 * The glob has no alternation and no nested groups, so it needs no backtracking:
 * split on '*', anchor the first and last literal segments, and scan the middle
 * ones left to right. Taking the earliest occurrence of each middle segment is
 * always safe here, because the '*' between them absorbs anything skipped — so a
 * greedy first match can never rule out an overall match. That makes matching
 * O(pattern x url) with no exponential case.
 *
 * Semantics follow CDP exactly: '*' is zero or more of ANY character (it spans
 * '/', unlike a filesystem glob), '?' is exactly one, everything else is literal.
 */
export function compileUrlPattern(pattern: string): (url: string) => boolean {
	// Cap pattern length so a pathological pattern cannot blow up the segment scan.
	if (pattern.length > 256) throw new TypeError('pattern too long')
	// '**' is accepted as a synonym for '*' so previously-written patterns keep working.
	const segments = pattern.replace(/\*+/g, '*').split('*')

	// No wildcard at all: an exact match, modulo '?'.
	if (segments.length === 1) {
		const only = segments[0]!
		return (url) => url.length === only.length && matchAt(url, only, 0)
	}

	const first = segments[0]!
	const last = segments[segments.length - 1]!
	const middle = segments.slice(1, -1).filter((s) => s.length > 0)
	const minLength = segments.reduce((n, s) => n + s.length, 0)

	return (url) => {
		if (url.length < minLength) return false
		if (!matchAt(url, first, 0)) return false
		let pos = first.length
		for (const seg of middle) {
			const found = indexOfSegment(url, seg, pos)
			if (found === -1) return false
			pos = found + seg.length
		}
		const tailStart = url.length - last.length
		// The tail must not overlap what the head and middles already consumed.
		if (tailStart < pos) return false
		return matchAt(url, last, tailStart)
	}
}

/** Does `segment` match `text` at `offset`, treating '?' as exactly one char? */
function matchAt(text: string, segment: string, offset: number): boolean {
	if (offset + segment.length > text.length) return false
	for (let i = 0; i < segment.length; i++) {
		const p = segment[i]
		if (p === '?') continue
		if (text[offset + i] !== p) return false
	}
	return true
}

/** First index at or after `from` where `segment` matches, or -1. */
function indexOfSegment(text: string, segment: string, from: number): number {
	const limit = text.length - segment.length
	for (let i = from; i <= limit; i++) {
		if (matchAt(text, segment, i)) return i
	}
	return -1
}

export class FetchDomain extends Domain {
	private enabled = false
	private patterns: Pattern[] = []
	private pending = new Set<string>()
	private bodyCache = new Map<string, Uint8Array>()
	/** Cap on fulfilled bodies retained for Fetch.getResponseBody. */
	private static readonly MAX_CACHED_BODIES = 50

	constructor(
		dispatcher: CDPDispatcher,
		event: EmitEvent,
		private readonly rpc: WorkerEndpoint,
	) {
		super(dispatcher, event)
		this.registerHandlers()
	}

	private registerHandlers(): void {
		this.on('Fetch.enable', (p) => {
			this.enabled = true
			// CDP: omitted `patterns` means intercept everything. An empty list
			// would make matchesAnyPattern() reject every request instead.
			const rawPatterns = Array.isArray(p.patterns) ? p.patterns.filter(isRecord) : []
			const effective = rawPatterns.length > 0 ? rawPatterns : [{}]
			this.patterns = effective.map((pat) => ({
				matchUrl: compileUrlPattern(typeof pat.urlPattern === 'string' ? pat.urlPattern : '*'),
				resourceType: typeof pat.resourceType === 'string' ? pat.resourceType : undefined,
			}))
			return {}
		})
		this.on('Fetch.disable', () => {
			this.disable()
			return {}
		})

		this.on('Fetch.continueRequest', (p) => {
			const q = this.extract<FetchContinueRequestParams>(p)
			this.settle(q.requestId, {
				action: 'continue',
				url: q.url,
				method: q.method,
				headers: this.headersToMap(q.headers),
				postData: q.postData ? this.decodeBase64(q.postData) : undefined,
			})
			return {}
		})
		this.on('Fetch.fulfillRequest', (p) => {
			const q = this.extract<FetchFulfillRequestParams>(p)
			const body = q.body ? this.decodeBase64(q.body) : new Uint8Array(0)
			// Bounded: DevTools never releases fulfilled bodies explicitly.
			if (this.bodyCache.size >= FetchDomain.MAX_CACHED_BODIES) {
				const oldest = this.bodyCache.keys().next().value
				if (oldest !== undefined) this.bodyCache.delete(oldest)
			}
			this.bodyCache.set(q.requestId, body)
			this.settle(q.requestId, {
				action: 'fulfill',
				responseCode: q.responseCode,
				responseHeaders: (q.responseHeaders ?? []).map<[string, string]>((h) => [h.name, h.value]),
				body,
			})
			return {}
		})
		this.on('Fetch.failRequest', (p) => {
			const q = this.extract<FetchFailRequestParams>(p)
			this.settle(q.requestId, { action: 'fail', reason: q.errorReason ?? q.reason ?? 'BlockedByClient' })
			return {}
		})
		this.on('Fetch.continueWithAuth', () => ({}))
		this.on('Fetch.continueResponse', (p) => {
			const q = this.extract<FetchContinueResponseParams>(p)
			this.settle(q.requestId, { action: 'continue' })
			return {}
		})
		this.on('Fetch.getResponseBody', (p) => {
			const body = this.bodyCache.get(this.reqStr(p, 'requestId'))
			if (!body) return { body: '', base64Encoded: true }
			return { body: this.encodeBase64(body), base64Encoded: true }
		})
	}

	private settle(requestId: string, result: InterceptResult): void {
		if (this.pending.delete(requestId)) {
			this.rpc.notify('fetchInterceptResult', { requestId, result })
		}
	}

	/**
	 * DevTools detached: release every paused request. Without this the native
	 * fetch promise behind a Fetch.requestPaused never settles and the program
	 * hangs waiting for a continue/fulfill that can no longer arrive.
	 */
	setConnected(connected: boolean): void {
		if (!connected) this.disable()
	}

	private disable(): void {
		this.enabled = false
		this.patterns = []
		for (const requestId of this.pending) {
			this.rpc.notify('fetchInterceptResult', { requestId, result: null })
		}
		this.pending.clear()
		this.bodyCache.clear()
	}

	onInterceptRequest(data: FetchInterceptPayload): void {
		if (!this.enabled || !this.matchesAnyPattern(data.url, data.resourceType)) {
			this.rpc.notify('fetchInterceptResult', { requestId: data.requestId, result: null })
			return
		}
		const request: Record<string, unknown> = {
			url: data.url,
			method: data.method,
			headers: data.headers,
			initialPriority: 'High',
			referrerPolicy: 'strict-origin-when-cross-origin',
			postData: data.postData ? this.encodeBase64(data.postData) : undefined,
		}
		this.event('Fetch.requestPaused', {
			requestId: data.requestId,
			request,
			frameId: 'cno-frame-1',
			resourceType: data.resourceType ?? 'Fetch',
		})
		this.pending.add(data.requestId)
	}

	private matchesAnyPattern(url: string, resourceType?: string): boolean {
		for (const pat of this.patterns) {
			if (!pat.matchUrl(url)) continue
			if (pat.resourceType && resourceType && pat.resourceType !== resourceType) continue
			return true
		}
		return false
	}

	private headersToMap(headers?: HeaderEntry[]): Record<string, string> | undefined {
		if (!headers) return undefined
		const out: Record<string, string> = {}
		for (const h of headers) out[h.name] = h.value
		return out
	}

	private encodeBase64(bytes: Uint8Array): string {
		return nativeCrypto.base64Encode(bytes)
	}

	private decodeBase64(value: string): Uint8Array {
		return new Uint8Array(nativeCrypto.base64Decode(value))
	}
}
