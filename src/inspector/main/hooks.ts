/**
 * main/hooks.ts — bridge native main-thread signals into worker events.
 *
 * Installs the script-init, fetch/websocket/intercept, lifecycle and binding
 * hooks. Each callback normalizes the native info object into a typed wire
 * payload (see shared/wire.ts) and forwards it to the worker. The script-init
 * hook is exposed (not auto-installed) so run.ts can register it on the runtime.
 */

import { getTierLimits } from '../../../cno/src/utils/memory-tier'
import {
	captureUserNetworkCallFrames,
	getFetchHook,
	getServeHook,
	setFetchHook,
	setFetchInterceptHook,
	setServeHook,
	setWebSocketHook,
	type FetchDataInfo,
	type FetchFinishedInfo,
	type FetchRequestInfo,
	type FetchResponseInfo,
	type NetworkCallFrame as HookNetworkCallFrame,
	type InterceptResult,
	type ServeDataInfo,
	type ServeFinishedInfo,
	type ServeRequestInfo,
	type ServeResponseInfo,
} from '../../../cno/src/utils/network-hooks'
import type { ModuleInfo } from '../../../cts/src/api'
import { toPosixPath } from '../../../cts/src/api'
import { native } from '../shared/native'
import { isUserFile } from '../shared/user-files'
import {
	NetFetchKind,
	NetServeKind,
	NetWSKind,
	WorkerEvent,
	type BindingCalledPayload,
	type ConsoleCallFrame,
	type ConsolePayload,
	type FetchInterceptPayload,
	type LoadPayload,
	type NetFetchDone,
	type NetFetchReq,
	type NetFetchRes,
	type NetServeDone,
	type NetServeReq,
	type NetServeRes,
	type NetWSClosed,
	type NetWSCreated,
	type NetWSFrame,
	type NetWSHandshake,
	type ScriptParsedPayload,
} from '../shared/wire'
import type { MainEndpoint } from '../transport/main-endpoint'
import type { Serializer } from './remote-object'

const engine = import.meta.use('engine')
const fs = import.meta.use('fs')
const os = import.meta.use('os')
const debug = import.meta.use('debug')


const kOrigin = Symbol('console.origin')
const { inspectorPreviewBodyBytes, maxPendingBodyBytes } = getTierLimits()
const MAX_COMPLETED_BODIES = 50

interface BodyBufferState {
	chunks: Uint8Array[]
	total: number
	createdAt: number
}

type ConsoleMethod = (...args: never[]) => void

export class Hooks {
	private readonly pendingIntercepts = new Map<string, (result: InterceptResult | null) => void>()
	private readonly installedBindings = new Set<string>()
	private readonly scriptSourcePaths = new Map<string, string>()
	// Body buffer accumulators — chunks are held here until the Done event fires,
	// then flushed as part of the Done payload. This avoids per-chunk pipe writes
	// (which carry large Uint8Array payloads and saturate the TCP socket buffer).
	private readonly fetchBodyBuffers = new Map<string, BodyBufferState>()
	private readonly serveBodyBuffers = new Map<string, BodyBufferState>()
	private readonly completedFetchBodies = new Map<string, { data: Uint8Array; createdAt: number }>()
	private readonly completedServeBodies = new Map<string, { data: Uint8Array; createdAt: number }>()
	private readonly fetchBodyTotals = new Map<string, number>()
	private readonly serveBodyTotals = new Map<string, number>()
	private fetchBodyBufferBytes = 0
	private serveBodyBufferBytes = 0
	private lastBufferCleanupTime = 0
	private readonly liveStreamedFetchRequests = new Set<string>()
	private readonly liveStreamedServeRequests = new Set<string>()
	private readonly droppedFetchBodyRequests = new Set<string>()
	private readonly droppedServeBodyRequests = new Set<string>()
	private scriptHookInstalled = false
	private consoleOriginals: Record<string, ConsoleMethod> | null = null

	/** Set by installScript(); run.ts wires this into runtime.addInitHook(). */
	scriptInitHook: ((specPath: string, info: ModuleInfo) => void) | null = null

	constructor(private readonly endpoint: MainEndpoint, private readonly serializer: Serializer) {}

	installAll(): void {
		this.installScript()
		this.installNetwork()
		this.installLifecycle()
		this.installConsole()
	}

	// ── script ──────────────────────────────────────────────────────
	private installScript(): void {
		if (this.scriptHookInstalled) return
		this.scriptHookInstalled = true
		this.scriptInitHook = (specPath: string, info: ModuleInfo) => {
			const sourcePath = info.localPath || specPath
			this.scriptSourcePaths.set(specPath, sourcePath)
			const url = devtoolsScriptUrl(specPath, sourcePath)
			let length = 0
			let endLine = 0
			try {
				const buf = fs.readFile(sourcePath)
				const str = engine.decodeString(buf)
				length = str.length
				endLine = (str.match(/\n/g) ?? []).length
			} catch {
				/* unreadable source — report zero length */
			}
			this.safeEmit(WorkerEvent.ScriptParsed, { scriptId: specPath, url, sourcePath, length, endLine } satisfies ScriptParsedPayload)
		}
	}

	scriptSourcePath(scriptId: string): string {
		const direct = this.scriptSourcePaths.get(scriptId)
		if (direct) return direct
		const normalized = normalizeScriptPath(scriptId)
		for (const [specPath, sourcePath] of this.scriptSourcePaths) {
			if (sameScriptPath(specPath, normalized) || sameScriptPath(sourcePath, normalized)) {
				return sourcePath
			}
		}
		return scriptId
	}

	private scriptFrameLocation(file: string): { scriptId: string; url: string } {
		for (const [specPath, sourcePath] of this.scriptSourcePaths) {
			if (sameScriptPath(file, specPath) || sameScriptPath(file, sourcePath)) {
				return { scriptId: specPath, url: devtoolsScriptUrl(specPath, sourcePath) }
			}
		}
		return { scriptId: file, url: devtoolsScriptUrl(file, file) }
	}

	private normalizeNetworkCallFrames(callFrames?: HookNetworkCallFrame[]): ConsoleCallFrame[] | undefined {
		if (!callFrames || callFrames.length === 0) return undefined
		const normalized: ConsoleCallFrame[] = []
		for (const frame of callFrames) {
			if (!frame?.scriptId && !frame?.url) continue
			const loc = this.scriptFrameLocation(frame.scriptId || frame.url)
			normalized.push({
				functionName: frame.functionName,
				scriptId: loc.scriptId,
				url: loc.url,
				lineNumber: frame.lineNumber,
				columnNumber: frame.columnNumber,
			})
			if (normalized.length >= 32) break
		}
		return normalized.length > 0 ? normalized : undefined
	}

	// ── network ─────────────────────────────────────────────────────
	private installNetwork(): void {
		Reflect.set(debug, '__cnoNetworkHooks', {
			getFetchHook: () => getFetchHook(),
			getServeHook: () => getServeHook(),
			captureCallFrames: () => this.captureNetworkCallFrames(),
		})
		setFetchHook({
			onRequest: (i: FetchRequestInfo) =>
				this.safeEmit(WorkerEvent.NetFetch, {
					ev: NetFetchKind.Req,
					source: 'fetch',
					requestId: i.requestId,
					timestamp: i.timestamp,
					url: i.url,
					method: i.method,
					headers: i.headers,
					postData: i.postData ?? undefined,
					callFrames: this.normalizeNetworkCallFrames(i.callFrames),
					resourceType: i.resourceType,
				} satisfies NetFetchReq),
			onResponse: (i: FetchResponseInfo) =>
				this.safeEmit(WorkerEvent.NetFetch, {
					ev: NetFetchKind.Res,
					source: 'fetch',
					requestId: i.requestId,
					timestamp: i.timestamp,
					url: i.url,
					status: i.status,
					headers: i.headers,
					requestHeaders: i.requestHeaders,
					resourceType: i.resourceType,
					connection: i.connection,
				} satisfies NetFetchRes),
			onData: (i: FetchDataInfo) => {
				// Buffer body chunks on the main thread — flushed with Done event
				// to avoid saturating the pipe with per-chunk writes.
				this.handleFetchBodyData(i)
			},
			onFinished: (i: FetchFinishedInfo) => {
				// Flush accumulated body chunks with the Done event.
				// The body may be in fetchBodyBuffers (normal) or completedFetchBodies
				// (if the buffer was truncated by preview/capacity limits).
				const buf = this.fetchBodyBuffers.get(i.requestId)
				const mergedEntry = this.completedFetchBodies.get(i.requestId)
				this.dropFetchBodyBuffer(i.requestId)
				this.completedFetchBodies.delete(i.requestId)
				const totalBytes = this.fetchBodyTotals.get(i.requestId) ?? buf?.total ?? 0
				this.fetchBodyTotals.delete(i.requestId)
				this.liveStreamedFetchRequests.delete(i.requestId)
				this.droppedFetchBodyRequests.delete(i.requestId)
				this.cleanupStaleBodyBuffers()
				const body = mergedEntry ? [mergedEntry.data] : buf?.chunks
				this.safeEmit(WorkerEvent.NetFetch, {
					ev: NetFetchKind.Done,
					source: 'fetch',
					requestId: i.requestId,
					timestamp: i.timestamp,
					success: i.success,
					errorText: i.errorText,
					connection: i.connection,
					body,
					totalBytes,
				} satisfies NetFetchDone)
			},
		})

		setServeHook({
			onRequest: (i: ServeRequestInfo) =>
				this.safeEmit(WorkerEvent.NetServe, {
					ev: NetServeKind.Req,
					source: 'serve',
					requestId: i.requestId,
					timestamp: i.timestamp,
					url: i.url,
					method: i.method,
					headers: i.headers,
					postData: i.postData ?? undefined,
					callFrames: this.normalizeNetworkCallFrames(i.callFrames),
				} satisfies NetServeReq),
			onResponse: (i: ServeResponseInfo) =>
				this.safeEmit(WorkerEvent.NetServe, {
					ev: NetServeKind.Res,
					source: 'serve',
					requestId: i.requestId,
					timestamp: i.timestamp,
					url: i.url,
					status: i.status,
					statusText: i.statusText,
					headers: i.headers,
				} satisfies NetServeRes),
			onData: (i: ServeDataInfo) => {
				// Buffer body chunks on the main thread — flushed with Done event.
				this.handleServeBodyData(i)
			},
			onFinished: (i: ServeFinishedInfo) => {
				// Flush accumulated body chunks with the Done event.
				const buf = this.serveBodyBuffers.get(i.requestId)
				const mergedEntry = this.completedServeBodies.get(i.requestId)
				this.dropServeBodyBuffer(i.requestId)
				this.completedServeBodies.delete(i.requestId)
				const totalBytes = this.serveBodyTotals.get(i.requestId) ?? buf?.total ?? 0
				this.serveBodyTotals.delete(i.requestId)
				this.liveStreamedServeRequests.delete(i.requestId)
				this.droppedServeBodyRequests.delete(i.requestId)
				this.cleanupStaleBodyBuffers()
				const body = mergedEntry ? [mergedEntry.data] : buf?.chunks
				this.safeEmit(WorkerEvent.NetServe, {
					ev: NetServeKind.Done,
					source: 'serve',
					requestId: i.requestId,
					timestamp: i.timestamp,
					success: i.success,
					errorText: i.errorText,
					body,
					totalBytes,
				} satisfies NetServeDone)
			},
		})

		setWebSocketHook({
			onCreated: (i) =>
				this.safeEmit(WorkerEvent.NetWs, {
					ev: NetWSKind.Created,
					source: i.source,
					requestId: i.requestId,
					url: i.url,
					requestHeaders: i.requestHeaders,
					callFrames: this.normalizeNetworkCallFrames(i.callFrames),
					timestamp: i.timestamp,
				} satisfies NetWSCreated),
			onHandshake: (i) =>
				this.safeEmit(WorkerEvent.NetWs, {
					ev: NetWSKind.Handshake,
					source: i.source,
					requestId: i.requestId,
					status: i.status,
					headers: i.headers,
					timestamp: i.timestamp,
				} satisfies NetWSHandshake),
			onFrameReceived: (i) =>
				this.safeEmit(WorkerEvent.NetWs, {
					ev: NetWSKind.Recv,
					source: i.source,
					requestId: i.requestId,
					opcode: i.opcode,
					masked: i.masked,
					payloadData: i.payloadData,
					payloadLength: i.payloadLength,
					timestamp: i.timestamp,
				} satisfies NetWSFrame),
			onFrameSent: (i) =>
				this.safeEmit(WorkerEvent.NetWs, {
					ev: NetWSKind.Sent,
					source: i.source,
					requestId: i.requestId,
					opcode: i.opcode,
					masked: i.masked,
					payloadData: i.payloadData,
					payloadLength: i.payloadLength,
					timestamp: i.timestamp,
				} satisfies NetWSFrame),
			onClosed: (i) =>
				this.safeEmit(WorkerEvent.NetWs, {
					ev: NetWSKind.Closed,
					source: i.source,
					requestId: i.requestId,
					code: i.code,
					reason: i.reason,
					timestamp: i.timestamp,
				} satisfies NetWSClosed),
		})

		// Fetch interception blocks the native fetch until DevTools resolves it
		// (continueRequest / fulfillRequest / failRequest) via fetchInterceptResult.
		setFetchInterceptHook({
			onRequest: (info) =>
				new Promise<InterceptResult | null>((resolve) => {
					this.safeEmit(WorkerEvent.FetchIntercept, {
						requestId: info.requestId,
						url: info.url,
						method: info.method,
						headers: info.headers,
						postData: info.postData ?? undefined,
						resourceType: info.resourceType,
					} satisfies FetchInterceptPayload)
					this.pendingIntercepts.set(info.requestId, resolve)
				}),
		})
	}

	private captureNetworkCallFrames(): HookNetworkCallFrame[] | undefined {
		return captureUserNetworkCallFrames()
	}

	/** Resolve a pending interception (called from the fetchInterceptResult RPC). */
	resolveIntercept(requestId: string, result: InterceptResult | null): void {
		const resolve = this.pendingIntercepts.get(requestId)
		if (!resolve) return
		this.pendingIntercepts.delete(requestId)
		resolve(result)
	}

	enableStreamingForRequest(requestId: string): void {
		this.liveStreamedFetchRequests.add(requestId)
		this.liveStreamedServeRequests.add(requestId)
		this.droppedFetchBodyRequests.delete(requestId)
		this.droppedServeBodyRequests.delete(requestId)
		this.dropFetchBodyBuffer(requestId)
		this.dropServeBodyBuffer(requestId)
	}

	// ── lifecycle ───────────────────────────────────────────────────
	private installLifecycle(): void {
		const add = Reflect.get(globalThis, 'addEventListener')
		if (typeof add !== 'function') return
		Reflect.apply(add, globalThis, [
			'load',
			() => this.safeEmit(WorkerEvent.Load, { timestamp: Date.now() / 1000 } satisfies LoadPayload),
			{ once: true },
		])
	}

	// ── console ─────────────────────────────────────────────────────
	private installConsole(): void {
		const con = globalThis.console;
		const methods = ['log', 'warn', 'error', 'info', 'debug', 'dir', 'trace', 'table', 'assert', 'time', 'timeEnd', 'timeLog', 'count', 'countReset', 'group', 'groupEnd'] as const
		const originals: Record<string, ConsoleMethod> = {}
		for (const m of methods) {
			const fn = con[m];
			if (typeof fn === 'function') originals[m] = fn;
		}
		// Saved here so log.ts can bypass the hook for internal messages.
		Reflect.set(con, kOrigin, originals);
		this.consoleOriginals = originals

		for (const method of methods) {
			const orig = originals[method]
			if (!orig) continue
			con[method] = (...args: unknown[]) => {
				const callFrames = this.captureConsoleCallFrames()
				Reflect.apply(orig, globalThis.console, args)
				try {
					const serialized = args.map(a => this.serializer.serialize(a, 'console', { preview: true }))

					this.safeEmit(WorkerEvent.Console, {
						method,
						args: serialized,
						timestamp: Date.now(),
						callFrames: callFrames.length > 0 ? callFrames : undefined,
					} satisfies ConsolePayload)
				} catch { /* ignore serialization errors */ }
			}
		}
	}

	private captureConsoleCallFrames(): ConsoleCallFrame[] {
		const callFrames: ConsoleCallFrame[] = []
		try {
			const depth = native.getStackDepth()
			for (let level = 2; level < depth && callFrames.length < 32; level++) {
				const info = native.getFrameInfo(level)
				if (!info) continue
				const fname = info.func?.name || ''
				if (!isUserFile(info.file)) continue
				const loc = this.scriptFrameLocation(info.file)
				callFrames.push({
					functionName: fname,
					scriptId: loc.scriptId,
					url: loc.url,
					lineNumber: Math.max(0, info.line - 1),
					columnNumber: Math.max(0, info.column - 1),
				})
			}
		} catch { /* ignore frame inspection errors */ }
		return callFrames
	}

	// ── bindings ────────────────────────────────────────────────────
	installBinding(name: string): void {
		if (!name || this.installedBindings.has(name)) return
		this.installedBindings.add(name)
		try {
			Reflect.set(globalThis, name, (payload: unknown) => {
				const str = typeof payload === 'string' ? payload : String(payload)
				this.safeEmit(WorkerEvent.BindingCalled, { name, payload: str } satisfies BindingCalledPayload)
			})
		} catch {
			/* ignore */
		}
	}

	removeBinding(name: string): void {
		this.installedBindings.delete(name)
		try {
			Reflect.deleteProperty(globalThis, name)
		} catch {
			/* ignore */
		}
	}

	// ── teardown ────────────────────────────────────────────────────
	teardown(): void {
		// Resolve all pending intercepts so native hooks don't hang.
		for (const resolve of this.pendingIntercepts.values()) resolve(null)
		this.pendingIntercepts.clear()
		this.installedBindings.clear()
		this.scriptSourcePaths.clear()
		this.fetchBodyBuffers.clear()
		this.serveBodyBuffers.clear()
		this.fetchBodyTotals.clear()
		this.serveBodyTotals.clear()
		this.fetchBodyBufferBytes = 0
		this.serveBodyBufferBytes = 0
		this.liveStreamedFetchRequests.clear()
		this.liveStreamedServeRequests.clear()
		this.droppedFetchBodyRequests.clear()
		this.droppedServeBodyRequests.clear()
		this.completedFetchBodies.clear()
		this.completedServeBodies.clear()
		this.scriptHookInstalled = false
		this.scriptInitHook = null
		if (this.consoleOriginals) {
			const con = globalThis.console;
			for (const [m, fn] of Object.entries(this.consoleOriginals))
				Reflect.set(con, m, fn)
			Reflect.deleteProperty(con, kOrigin);
			this.consoleOriginals = null
		}
		try {
			setFetchHook(null)
		} catch {
			/* ignore */
		}
		try {
			setWebSocketHook(null)
		} catch {
			/* ignore */
		}
		try {
			setFetchInterceptHook(null)
		} catch {
			/* ignore */
		}
		try {
			setServeHook(null)
		} catch {
			/* ignore */
		}
		try {
			Reflect.deleteProperty(debug, '__cnoNetworkHooks')
		} catch {
			/* ignore */
		}
	}

	private safeEmit(ev: WorkerEvent, params: unknown): void {
		try {
			this.endpoint.emit(ev, params)
		} catch {
			/* worker gone */
		}
	}

	private handleFetchBodyData(i: FetchDataInfo): void {
		const data = this.copyBytes(i.data)
		this.fetchBodyTotals.set(i.requestId, (this.fetchBodyTotals.get(i.requestId) ?? 0) + i.data.byteLength)
		if (this.liveStreamedFetchRequests.has(i.requestId)) {
			this.safeEmit(WorkerEvent.NetFetch, {
				ev: NetFetchKind.Data,
				source: 'fetch',
				requestId: i.requestId,
				timestamp: i.timestamp,
				data,
				byteLength: data.byteLength,
			})
			return
		}
		if (this.droppedFetchBodyRequests.has(i.requestId)) {
			this.safeEmit(WorkerEvent.NetFetch, {
				ev: NetFetchKind.Data,
				source: 'fetch',
				requestId: i.requestId,
				timestamp: i.timestamp,
				data: new Uint8Array(0),
				byteLength: i.data.byteLength,
			})
			return
		}
		const buf = this.fetchBodyBuffers.get(i.requestId) ?? (() => {
			const state: BodyBufferState = { chunks: [], total: 0, createdAt: Date.now() }
			this.fetchBodyBuffers.set(i.requestId, state)
			return state
		})()
		if (buf.total + i.data.byteLength > inspectorPreviewBodyBytes) {
			this.evictOldestBody(this.completedFetchBodies)
			this.completedFetchBodies.set(i.requestId, { data: this.mergeChunks(buf.chunks), createdAt: Date.now() })
			this.droppedFetchBodyRequests.add(i.requestId)
			this.fetchBodyBufferBytes = Math.max(0, this.fetchBodyBufferBytes - buf.total)
			buf.chunks = []
			buf.total = 0
			this.safeEmit(WorkerEvent.NetFetch, {
				ev: NetFetchKind.Data,
				source: 'fetch',
				requestId: i.requestId,
				timestamp: i.timestamp,
				data: new Uint8Array(0),
				byteLength: i.data.byteLength,
			})
			return
		}
		if (!this.ensureFetchBodyCapacity(i.requestId, i.data.byteLength)) {
			this.safeEmit(WorkerEvent.NetFetch, {
				ev: NetFetchKind.Data,
				source: 'fetch',
				requestId: i.requestId,
				timestamp: i.timestamp,
				data: new Uint8Array(0),
				byteLength: i.data.byteLength,
			})
			return
		}
		buf.chunks.push(data)
		buf.total += data.byteLength
		this.fetchBodyBufferBytes += data.byteLength
	}

	private handleServeBodyData(i: ServeDataInfo): void {
		const data = this.copyBytes(i.data)
		this.serveBodyTotals.set(i.requestId, (this.serveBodyTotals.get(i.requestId) ?? 0) + i.data.byteLength)
		if (this.liveStreamedServeRequests.has(i.requestId)) {
			this.safeEmit(WorkerEvent.NetServe, {
				ev: NetServeKind.Data,
				source: 'serve',
				requestId: i.requestId,
				timestamp: i.timestamp,
				data,
				byteLength: data.byteLength,
			})
			return
		}
		if (this.droppedServeBodyRequests.has(i.requestId)) {
			this.safeEmit(WorkerEvent.NetServe, {
				ev: NetServeKind.Data,
				source: 'serve',
				requestId: i.requestId,
				timestamp: i.timestamp,
				data: new Uint8Array(0),
				byteLength: i.data.byteLength,
			})
			return
		}
		const buf = this.serveBodyBuffers.get(i.requestId) ?? (() => {
			const state: BodyBufferState = { chunks: [], total: 0, createdAt: Date.now() }
			this.serveBodyBuffers.set(i.requestId, state)
			return state
		})()
		if (buf.total + i.data.byteLength > inspectorPreviewBodyBytes) {
			this.evictOldestBody(this.completedServeBodies)
			this.completedServeBodies.set(i.requestId, { data: this.mergeChunks(buf.chunks), createdAt: Date.now() })
			this.droppedServeBodyRequests.add(i.requestId)
			this.serveBodyBufferBytes = Math.max(0, this.serveBodyBufferBytes - buf.total)
			buf.chunks = []
			buf.total = 0
			this.safeEmit(WorkerEvent.NetServe, {
				ev: NetServeKind.Data,
				source: 'serve',
				requestId: i.requestId,
				timestamp: i.timestamp,
				data: new Uint8Array(0),
				byteLength: i.data.byteLength,
			})
			return
		}
		if (!this.ensureServeBodyCapacity(i.requestId, i.data.byteLength)) {
			this.safeEmit(WorkerEvent.NetServe, {
				ev: NetServeKind.Data,
				source: 'serve',
				requestId: i.requestId,
				timestamp: i.timestamp,
				data: new Uint8Array(0),
				byteLength: i.data.byteLength,
			})
			return
		}
		buf.chunks.push(data)
		buf.total += data.byteLength
		this.serveBodyBufferBytes += data.byteLength
	}

	private maxPendingBodyBytes(): number {
		let raw: string | undefined
		try {
			raw = os.getenv('CNO_INSPECTOR_PENDING_BODY_MAX_BYTES') ?? undefined
		} catch {
			raw = undefined
		}
		if (!raw) return maxPendingBodyBytes
		const parsed = Number(raw)
		return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : maxPendingBodyBytes
	}

	private dropFetchBodyBuffer(requestId: string): void {
		const existing = this.fetchBodyBuffers.get(requestId)
		if (!existing) return
		this.fetchBodyBufferBytes = Math.max(0, this.fetchBodyBufferBytes - existing.total)
		this.fetchBodyBuffers.delete(requestId)
	}

	private dropServeBodyBuffer(requestId: string): void {
		const existing = this.serveBodyBuffers.get(requestId)
		if (!existing) return
		this.serveBodyBufferBytes = Math.max(0, this.serveBodyBufferBytes - existing.total)
		this.serveBodyBuffers.delete(requestId)
	}

	private dropFetchRequestBody(requestId: string): void {
		this.droppedFetchBodyRequests.add(requestId)
		const buf = this.fetchBodyBuffers.get(requestId)
		if (buf && buf.chunks.length > 0) {
			this.evictOldestBody(this.completedFetchBodies)
			this.completedFetchBodies.set(requestId, { data: this.mergeChunks(buf.chunks), createdAt: Date.now() })
		}
		this.dropFetchBodyBuffer(requestId)
	}

	private dropServeRequestBody(requestId: string): void {
		this.droppedServeBodyRequests.add(requestId)
		const buf = this.serveBodyBuffers.get(requestId)
		if (buf && buf.chunks.length > 0) {
			this.evictOldestBody(this.completedServeBodies)
			this.completedServeBodies.set(requestId, { data: this.mergeChunks(buf.chunks), createdAt: Date.now() })
		}
		this.dropServeBodyBuffer(requestId)
	}

	private ensureFetchBodyCapacity(requestId: string, incomingBytes: number): boolean {
		const maxBytes = this.maxPendingBodyBytes()
		while (this.fetchBodyBufferBytes + incomingBytes > maxBytes && this.fetchBodyBuffers.size > 0) {
			const oldest = this.fetchBodyBuffers.keys().next().value
			if (oldest === undefined) break
			if (oldest === requestId && this.fetchBodyBuffers.size === 1) break
			this.dropFetchRequestBody(oldest)
		}
		if (this.fetchBodyBufferBytes + incomingBytes <= maxBytes) return true
		this.dropFetchRequestBody(requestId)
		return false
	}

	private ensureServeBodyCapacity(requestId: string, incomingBytes: number): boolean {
		const maxBytes = this.maxPendingBodyBytes()
		while (this.serveBodyBufferBytes + incomingBytes > maxBytes && this.serveBodyBuffers.size > 0) {
			const oldest = this.serveBodyBuffers.keys().next().value
			if (oldest === undefined) break
			if (oldest === requestId && this.serveBodyBuffers.size === 1) break
			this.dropServeRequestBody(oldest)
		}
		if (this.serveBodyBufferBytes + incomingBytes <= maxBytes) return true
		this.dropServeRequestBody(requestId)
		return false
	}

	/**
	 * Evict body buffers that have been pending for over 120 seconds, and
	 * truncated placeholders (total=0) older than 30 seconds.  When the Done
	 * event is lost (e.g. pipe saturation), these buffers would otherwise leak
	 * indefinitely.  Runs at most once every 30 s.
	 */
	private cleanupStaleBodyBuffers(): void {
		const now = Date.now()
		if (now - this.lastBufferCleanupTime < 30_000) return
		this.lastBufferCleanupTime = now
		const staleCutoff = now - 120_000
		const truncCutoff = now - 30_000
		for (const [id, buf] of this.fetchBodyBuffers) {
			if (buf.createdAt < staleCutoff || (buf.total === 0 && buf.createdAt < truncCutoff)) {
				this.fetchBodyBufferBytes = Math.max(0, this.fetchBodyBufferBytes - buf.total)
				this.fetchBodyBuffers.delete(id)
				this.fetchBodyTotals.delete(id)
				this.liveStreamedFetchRequests.delete(id)
				this.droppedFetchBodyRequests.delete(id)
			}
		}
		for (const [id, buf] of this.serveBodyBuffers) {
			if (buf.createdAt < staleCutoff || (buf.total === 0 && buf.createdAt < truncCutoff)) {
				this.serveBodyBufferBytes = Math.max(0, this.serveBodyBufferBytes - buf.total)
				this.serveBodyBuffers.delete(id)
				this.serveBodyTotals.delete(id)
				this.liveStreamedServeRequests.delete(id)
				this.droppedServeBodyRequests.delete(id)
			}
		}
		for (const [id, entry] of this.completedFetchBodies) {
			if (entry.createdAt < staleCutoff) this.completedFetchBodies.delete(id)
		}
		for (const [id, entry] of this.completedServeBodies) {
			if (entry.createdAt < staleCutoff) this.completedServeBodies.delete(id)
		}
	}

	private mergeChunks(chunks: Uint8Array[]): Uint8Array {
		const first = chunks[0]
		if (chunks.length === 1 && first !== undefined) return first
		let total = 0
		for (const c of chunks) total += c.byteLength
		const merged = new Uint8Array(total)
		let offset = 0
		for (const c of chunks) { merged.set(c, offset); offset += c.byteLength }
		return merged
	}

	private copyBytes(data: Uint8Array): Uint8Array {
		const copy = new Uint8Array(data.byteLength)
		copy.set(data)
		return copy
	}

	private evictOldestBody(map: Map<string, unknown>): void {
		if (map.size >= MAX_COMPLETED_BODIES) {
			const oldest = map.keys().next().value
			if (oldest !== undefined) map.delete(oldest)
		}
	}
}

function devtoolsScriptUrl(specPath: string, sourcePath: string): string {
	if (specPath.startsWith('http://') || specPath.startsWith('https://')) return specPath
	if (specPath.startsWith('jsr:')) return jsrDevtoolsUrl(specPath)
	if (specPath.startsWith('npm:')) return npmDevtoolsUrl(specPath)
	if (/^[A-Za-z]{2,}:/.test(specPath)) return `cno://modules/${encodePath(specPath)}`
	return fileUrl(sourcePath)
}

function jsrDevtoolsUrl(specPath: string): string {
	const m = specPath.match(/^jsr:@([^/]+)\/([^@/]+)@([^/]+)\/?(.*)$/)
	if (!m) return `https://jsr.io/${encodePath(specPath.slice(4))}`
	const [, scope, name, version, path = ''] = m
	return `https://jsr.io/@${scope}/${name}/${version}${path ? `/${path}` : ''}`
}

function npmDevtoolsUrl(specPath: string): string {
	const rest = specPath.slice(4).replace(/^\/+/, '')
	return `npm://registry/${encodePath(rest)}`
}

function fileUrl(path: string): string {
	const normalized = toPosixPath(path).replace(/^\//, '')
	return `file:///${normalized}`
}

function sameScriptPath(a: string, b: string): boolean {
	return a === b || normalizeScriptPath(a) === normalizeScriptPath(b)
}

function normalizeScriptPath(path: string): string {
	let normalized = toPosixPath(path)
	if (normalized.startsWith('file:///')) normalized = normalized.slice('file:///'.length)
	const drive = normalized[0]
	if (drive !== undefined && /^[A-Za-z]:/.test(normalized)) return drive.toUpperCase() + normalized.slice(1)
	return normalized
}

function encodePath(path: string): string {
	return path.split('/').map(encodeURIComponent).join('/')
}
