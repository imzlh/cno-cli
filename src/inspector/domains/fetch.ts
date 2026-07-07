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
	urlRegex: RegExp
	resourceType?: string
	requestStage: string
}

interface PendingRequest {
	requestId: string
	request: Record<string, unknown>
	resolve: (result: InterceptResult | null) => void
}

interface HeaderEntry {
	name: string
	value: string
}

function globToRegex(pattern: string): RegExp {
	let out = ''
	for (let i = 0; i < pattern.length; i++) {
		const ch = pattern[i]
		if (ch === '*') {
			out += pattern[i + 1] === '*' ? '.*' : '[^/]*'
			if (pattern[i + 1] === '*') i++ // skip second *
		} else if (ch === '?') {
			out += '.'
		} else {
			out += ch.replace(/[.+^${}()|[\]\\]/g, '\\$&')
		}
	}
	return new RegExp(`^${out}$`)
}

export class FetchDomain extends Domain {
	private enabled = false
	private patterns: Pattern[] = []
	private handleAuthRequests = false
	private pending = new Map<string, PendingRequest>()
	private bodyCache = new Map<string, Uint8Array>()

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
			this.handleAuthRequests = this.bool(p, 'handleAuthRequests')
			const rawPatterns = Array.isArray(p.patterns) ? p.patterns.filter(isRecord) : []
			this.patterns = rawPatterns.map((pat) => ({
				urlRegex: globToRegex(typeof pat.urlPattern === 'string' ? pat.urlPattern : '*'),
				resourceType: typeof pat.resourceType === 'string' ? pat.resourceType : undefined,
				requestStage: typeof pat.requestStage === 'string' ? pat.requestStage : 'Request',
			}))
			return {}
		})
		this.on('Fetch.disable', () => {
			this.enabled = false
			this.patterns = []
			for (const pendingReq of this.pending.values()) pendingReq.resolve(null)
			this.pending.clear()
			this.bodyCache.clear()
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
		const pendingReq = this.pending.get(requestId)
		if (!pendingReq) return
		this.pending.delete(requestId)
		pendingReq.resolve(result)
	}

	onInterceptRequest(data: FetchInterceptPayload): void {
		if (!this.enabled || !this.matchesAnyPattern(data.url, data.resourceType)) {
			void this.rpc.call('fetchInterceptResult', { requestId: data.requestId, result: null })
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
		this.pending.set(data.requestId, {
			requestId: data.requestId,
			request,
			resolve: (result) => {
				void this.rpc.call('fetchInterceptResult', { requestId: data.requestId, result })
			},
		})
	}

	private matchesAnyPattern(url: string, resourceType?: string): boolean {
		for (const pat of this.patterns) {
			if (!pat.urlRegex.test(url)) continue
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
		return nativeCrypto.base64Encode(new Uint8Array(bytes))
	}

	private decodeBase64(value: string): Uint8Array {
		return new Uint8Array(nativeCrypto.base64Decode(value))
	}
}
