/**
 * main/hooks.ts — bridge native main-thread signals into worker events via
 * shared/wire.ts payloads. The script-init hook is exposed, not auto-installed.
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
import { getMemoryFile } from '../../../cts/src/utils/memfs'
import { fileUrlToPath, toFileUrl, toPosixPath } from '../../../cts/src/utils/path'
import type { ModuleInfo } from '../../../cts/src/types'
import { native } from '../shared/native'
import { remapConsoleFrame, type SourceMapLookup } from '../shared/console-utils'
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
import { readEnv } from '../../env'

const engine = import.meta.use('engine')
const fs = import.meta.use('fs')
const sourcemap = import.meta.use('sourcemap') as SourceMapLookup
const debug = import.meta.use('debug')
const console = import.meta.use('console')

const kOrigin = Symbol('console.origin')
const { inspectorPreviewBodyBytes, maxPendingBodyBytes } = getTierLimits()
const MAX_COMPLETED_BODIES = 50
const CONSOLE_HOOK_OFFSET = 4

interface BodyBufferState {
	chunks: Uint8Array[]
	total: number
	createdAt: number
}

interface BodySourceState {
	buffers: Map<string, BodyBufferState>
	completed: Map<string, { data: Uint8Array; createdAt: number }>
	totals: Map<string, number>
	bytes: number
	live: Set<string>
	dropped: Set<string>
}

function createBodySourceState(): BodySourceState {
	return {
		buffers: new Map(),
		completed: new Map(),
		totals: new Map(),
		bytes: 0,
		live: new Set(),
		dropped: new Set(),
	}
}

type ConsoleMethod = (...args: never[]) => void

export class Hooks {
	private readonly pendingIntercepts = new Map<string, (result: InterceptResult | null) => void>()
	private readonly installedBindings = new Set<string>()
	private readonly scriptSourcePaths = new Map<string, string>()
	// Chunks accumulate here until the Done event, which carries the whole body;
	// per-chunk pipe writes saturate the socket buffer.
	private readonly bodySources = {
		fetch: createBodySourceState(),
		serve: createBodySourceState(),
	}
	private lastBufferCleanupTime = 0
	/** Streaming drops the body buffer, so these ids need their own reaper map. */
	private readonly streamRegisteredAt = new Map<string, number>()
	private scriptHookInstalled = false
	private loadListener: (() => void) | null = null
	private consoleOriginals: Record<string, ConsoleMethod> | null = null

	/** Set by installScript(); run.ts wires this into runtime.addInitHook(). */
	scriptInitHook: ((specPath: string, info: ModuleInfo) => void) | null = null

	constructor(private readonly endpoint: MainEndpoint, private readonly serializer: Serializer) {}

	memoryUsage() {
		let completedFetchBodyBytes = 0
		let completedServeBodyBytes = 0
		for (const { data } of this.bodySources.fetch.completed.values()) completedFetchBodyBytes += data.byteLength
		for (const { data } of this.bodySources.serve.completed.values()) completedServeBodyBytes += data.byteLength
		return {
			pendingIntercepts: this.pendingIntercepts.size,
			fetchBodyBufferCount: this.bodySources.fetch.buffers.size,
			fetchBodyBufferBytes: this.bodySources.fetch.bytes,
			serveBodyBufferCount: this.bodySources.serve.buffers.size,
			serveBodyBufferBytes: this.bodySources.serve.bytes,
			completedFetchBodyCount: this.bodySources.fetch.completed.size,
			completedFetchBodyBytes,
			completedServeBodyCount: this.bodySources.serve.completed.size,
			completedServeBodyBytes,
			liveFetchStreamCount: this.bodySources.fetch.live.size,
			liveServeStreamCount: this.bodySources.serve.live.size,
		}
	}

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
				// pack:/VFS localPaths are not on disk — prefer active store.
				const mem = getMemoryFile(sourcePath)
				const buf = mem !== undefined ? mem : fs.readFile(sourcePath)
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

	/** Map a physical file to the scriptId/url announced via scriptParsed. */
	frameLocationFor(file: string): { scriptId: string; url: string } {
		return this.scriptFrameLocation(file)
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
		for (let index = 0; index < callFrames.length; index++) {
			const frame = callFrames[index]
			if (!frame?.scriptId && !frame?.url) continue
			const mapped = index === 0
				? remapConsoleFrame(frame.scriptId || frame.url, frame.lineNumber, frame.columnNumber, sourcemap, true)
				: {
					filePath: frame.scriptId || frame.url,
					lineNumber: frame.lineNumber,
					columnNumber: frame.columnNumber,
				}
			const loc = this.scriptFrameLocation(mapped.filePath)
			normalized.push({
				functionName: frame.functionName,
				scriptId: loc.scriptId,
				url: loc.url,
				lineNumber: mapped.lineNumber,
				columnNumber: mapped.columnNumber,
			})
			if (normalized.length >= 32) break
		}
		return normalized.length > 0 ? normalized : undefined
	}

	// ── network ─────────────────────────────────────────────────────
	private installNetwork(): void {
		import.meta.use('evbus').set('cno.inspector', 'networkHooks', {
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
				// Buffer on the main thread; flushed with the Done event.
				this.handleBodyData('fetch', i)
			},
			onFinished: (i: FetchFinishedInfo) =>
				this.finishBody({
					ev: NetFetchKind.Done,
					source: 'fetch',
					requestId: i.requestId,
					timestamp: i.timestamp,
					success: i.success,
					errorText: i.errorText,
					connection: i.connection,
				} satisfies NetFetchDone),
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
				this.handleBodyData('serve', i)
			},
			onFinished: (i: ServeFinishedInfo) =>
				this.finishBody({
					ev: NetServeKind.Done,
					source: 'serve',
					requestId: i.requestId,
					timestamp: i.timestamp,
					success: i.success,
					errorText: i.errorText,
				} satisfies NetServeDone),
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
						callFrames: this.normalizeNetworkCallFrames(info.callFrames),
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

	/** Release every request paused by Fetch interception. */
	releasePendingIntercepts(): void {
		for (const resolve of this.pendingIntercepts.values()) resolve(null)
		this.pendingIntercepts.clear()
	}

	/**
	 * `source` must be exact: marking both sets leaks the wrong-source entry,
	 * which has no Done event to clear it. Optional for older workers.
	 */
	enableStreamingForRequest(requestId: string, source?: 'fetch' | 'serve'): Uint8Array {
		let fetchData: Uint8Array<ArrayBufferLike> = new Uint8Array(0)
		let serveData: Uint8Array<ArrayBufferLike> = new Uint8Array(0)
		if (source !== 'serve') {
			fetchData = this.takeBodyBuffer(this.bodySources.fetch, requestId)
			this.bodySources.fetch.live.add(requestId)
			this.bodySources.fetch.dropped.delete(requestId)
		}
		if (source !== 'fetch') {
			serveData = this.takeBodyBuffer(this.bodySources.serve, requestId)
			this.bodySources.serve.live.add(requestId)
			this.bodySources.serve.dropped.delete(requestId)
		}
		// Streaming drops the body buffer, so the id is absent from the two maps
		// the reaper iterates; record it so a lost Done event is still reclaimable.
		this.streamRegisteredAt.set(requestId, Date.now())
		if (fetchData.byteLength === 0) return serveData
		if (serveData.byteLength === 0) return fetchData
		return this.mergeChunks([fetchData, serveData])
	}

	// ── lifecycle ───────────────────────────────────────────────────
	private installLifecycle(): void {
		if (this.loadListener) return
		const add = Reflect.get(globalThis, 'addEventListener')
		if (typeof add !== 'function') return
		this.loadListener = () => {
			this.loadListener = null
			this.safeEmit(WorkerEvent.Load, { timestamp: Date.now() / 1000 } satisfies LoadPayload)
		}
		Reflect.apply(add, globalThis, [
			'load',
			this.loadListener,
			{ once: true },
		])
	}

	// ── console ─────────────────────────────────────────────────────
	private installConsole(): void {
		// Without this guard a second install captures the FIRST install's wrappers
		// as originals, so teardown restores a wrapper and the hook becomes permanent.
		if (this.consoleOriginals) return
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
			for (let level = CONSOLE_HOOK_OFFSET; level < depth && callFrames.length < 32; level++) {
				// getFrameInfo THROWS for a non-JS frame rather than returning null
				// (mod_debug.c), so catch per frame: one native frame must not discard
				// every frame already collected below it.
				let info: ReturnType<typeof native.getFrameInfo> | null = null
				try {
					info = native.getFrameInfo(level)
				} catch { continue }
				if (!info) continue
				const fname = info.func?.name || ''
				const mapped = level === CONSOLE_HOOK_OFFSET
					? remapConsoleFrame(info.file, info.line, info.column, sourcemap)
					: {
						filePath: info.file,
						lineNumber: info.line - 1,
						columnNumber: info.column - 1,
					}
				if (!isUserFile(mapped.filePath)) continue
				const loc = this.scriptFrameLocation(mapped.filePath)
				callFrames.push({
					functionName: fname,
					scriptId: loc.scriptId,
					url: loc.url,
					lineNumber: mapped.lineNumber,
					columnNumber: mapped.columnNumber,
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
		this.releasePendingIntercepts()
		if (this.loadListener) {
			const remove = Reflect.get(globalThis, 'removeEventListener')
			if (typeof remove === 'function') {
				Reflect.apply(remove, globalThis, ['load', this.loadListener])
			}
			this.loadListener = null
		}
		// Delete the properties, not just forget the names: clearing the set alone
		// left every Runtime.addBinding function alive on globalThis after detach,
		// each closing over a dead endpoint. removeBinding() already does this.
		for (const name of this.installedBindings) {
			try {
				Reflect.deleteProperty(globalThis, name)
			} catch { /* non-configurable: nothing we can do */ }
		}
		this.installedBindings.clear()
		this.scriptSourcePaths.clear()
		this.bodySources.fetch.buffers.clear()
		this.bodySources.serve.buffers.clear()
		this.bodySources.fetch.totals.clear()
		this.bodySources.serve.totals.clear()
		this.bodySources.fetch.bytes = 0
		this.bodySources.serve.bytes = 0
		this.bodySources.fetch.live.clear()
		this.bodySources.serve.live.clear()
		this.bodySources.fetch.dropped.clear()
		this.bodySources.serve.dropped.clear()
		this.streamRegisteredAt.clear()
		this.bodySources.fetch.completed.clear()
		this.bodySources.serve.completed.clear()
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
			import.meta.use('evbus').delete('cno.inspector', 'networkHooks')
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

	private handleBodyData(source: 'fetch' | 'serve', i: FetchDataInfo | ServeDataInfo): void {
		const state = this.bodySources[source]
		state.totals.set(i.requestId, (state.totals.get(i.requestId) ?? 0) + i.data.byteLength)
		let data: Uint8Array
		if (state.live.has(i.requestId)) {
			data = this.copyBytes(i.data)
		} else {
			if (!state.dropped.has(i.requestId)) {
				let buf = state.buffers.get(i.requestId)
				if (!buf) {
					buf = { chunks: [], total: 0, createdAt: Date.now() }
					state.buffers.set(i.requestId, buf)
				}
				if (buf.total + i.data.byteLength > inspectorPreviewBodyBytes) {
					this.evictOldestBody(state.completed)
					state.completed.set(i.requestId, { data: this.mergeChunks(buf.chunks), createdAt: Date.now() })
					state.dropped.add(i.requestId)
					state.bytes = Math.max(0, state.bytes - buf.total)
					// Preview truncation keeps a zero-byte placeholder for the 30 s reaper.
					buf.chunks = []
					buf.total = 0
				} else if (this.ensureBodyCapacity(state, i.requestId, i.data.byteLength)) {
					// Own only bytes that will be retained or forwarded, never a dropped chunk.
					const copy = this.copyBytes(i.data)
					buf.chunks.push(copy)
					buf.total += copy.byteLength
					state.bytes += copy.byteLength
					return
				}
			}
			data = new Uint8Array(0)
		}
		this.safeEmit(source === 'fetch' ? WorkerEvent.NetFetch : WorkerEvent.NetServe, {
			ev: source === 'fetch' ? NetFetchKind.Data : NetServeKind.Data,
			source,
			requestId: i.requestId,
			timestamp: i.timestamp,
			data,
			byteLength: i.data.byteLength,
		})
	}

	private finishBody(payload: NetFetchDone | NetServeDone): void {
		const state = this.bodySources[payload.source]
		const requestId = payload.requestId
		const buf = state.buffers.get(requestId)
		const completed = state.completed.get(requestId)
		this.dropBodyBuffer(state, requestId)
		state.completed.delete(requestId)
		const totalBytes = state.totals.get(requestId) ?? buf?.total ?? 0
		state.totals.delete(requestId)
		state.live.delete(requestId)
		state.dropped.delete(requestId)
		this.streamRegisteredAt.delete(requestId)
		this.cleanupStaleBodyBuffers()
		payload.body = completed ? [completed.data] : buf?.chunks
		payload.totalBytes = totalBytes
		this.safeEmit(payload.source === 'fetch' ? WorkerEvent.NetFetch : WorkerEvent.NetServe, payload)
	}

	private maxPendingBodyBytes(): number {
		const raw = readEnv('CNO_INSPECTOR_PENDING_BODY_MAX_BYTES') ?? undefined
		if (!raw) return maxPendingBodyBytes
		const parsed = Number(raw)
		return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : maxPendingBodyBytes
	}

	private dropBodyBuffer(state: BodySourceState, requestId: string): void {
		const existing = state.buffers.get(requestId)
		if (!existing) return
		state.bytes = Math.max(0, state.bytes - existing.total)
		state.buffers.delete(requestId)
	}

	private takeBodyBuffer(state: BodySourceState, requestId: string): Uint8Array<ArrayBufferLike> {
		const completed = state.completed.get(requestId)?.data
		const active = state.buffers.get(requestId)
		const chunks = completed ? [completed] : active?.chunks ?? []
		// A multi-chunk merge already owns its bytes; only the single-chunk path aliases.
		const data = chunks.length === 1 ? this.copyBytes(chunks[0]) : this.mergeChunks(chunks)
		state.completed.delete(requestId)
		this.dropBodyBuffer(state, requestId)
		return data
	}

	private dropRequestBody(state: BodySourceState, requestId: string): void {
		state.dropped.add(requestId)
		const buf = state.buffers.get(requestId)
		if (buf && buf.chunks.length > 0) {
			this.evictOldestBody(state.completed)
			state.completed.set(requestId, { data: this.mergeChunks(buf.chunks), createdAt: Date.now() })
		}
		this.dropBodyBuffer(state, requestId)
	}

	private ensureBodyCapacity(state: BodySourceState, requestId: string, incomingBytes: number): boolean {
		const maxBytes = this.maxPendingBodyBytes()
		// Never evict requestId itself: the caller already holds its buffer and
		// would keep appending to an orphaned object, permanently inflating
		// state.bytes with bytes no drop path can ever subtract.
		for (const id of state.buffers.keys()) {
			if (state.bytes + incomingBytes <= maxBytes) break
			if (id === requestId) continue
			this.dropRequestBody(state, id)
		}
		if (state.bytes + incomingBytes <= maxBytes) return true
		this.dropRequestBody(state, requestId)
		return false
	}

	/** Evict buffers pending over 120 s and lost truncated placeholders after 30 s. */
	private cleanupStaleBodyBuffers(): void {
		const now = Date.now()
		if (now - this.lastBufferCleanupTime < 30_000) return
		this.lastBufferCleanupTime = now
		const staleCutoff = now - 120_000
		const truncCutoff = now - 30_000
		for (const [id, buf] of this.bodySources.fetch.buffers) {
			if (buf.createdAt < staleCutoff || (buf.total === 0 && buf.createdAt < truncCutoff)) {
				this.bodySources.fetch.bytes = Math.max(0, this.bodySources.fetch.bytes - buf.total)
				this.bodySources.fetch.buffers.delete(id)
				this.bodySources.fetch.totals.delete(id)
				this.bodySources.fetch.live.delete(id)
				this.bodySources.fetch.dropped.delete(id)
			}
		}
		for (const [id, buf] of this.bodySources.serve.buffers) {
			if (buf.createdAt < staleCutoff || (buf.total === 0 && buf.createdAt < truncCutoff)) {
				this.bodySources.serve.bytes = Math.max(0, this.bodySources.serve.bytes - buf.total)
				this.bodySources.serve.buffers.delete(id)
				this.bodySources.serve.totals.delete(id)
				this.bodySources.serve.live.delete(id)
				this.bodySources.serve.dropped.delete(id)
			}
		}
		// Live-streamed ids hold no body buffer, so the loops above never see them;
		// sweep them by registration timestamp or a lost Done event pins them.
		for (const [id, at] of this.streamRegisteredAt) {
			if (at >= staleCutoff) continue
			if (this.bodySources.fetch.buffers.has(id) || this.bodySources.serve.buffers.has(id)) continue
			this.streamRegisteredAt.delete(id)
			this.bodySources.fetch.live.delete(id)
			this.bodySources.serve.live.delete(id)
			this.bodySources.fetch.dropped.delete(id)
			this.bodySources.serve.dropped.delete(id)
			this.bodySources.fetch.totals.delete(id)
			this.bodySources.serve.totals.delete(id)
		}
		for (const [id, entry] of this.bodySources.fetch.completed) {
			if (entry.createdAt < staleCutoff) this.bodySources.fetch.completed.delete(id)
		}
		for (const [id, entry] of this.bodySources.serve.completed) {
			if (entry.createdAt < staleCutoff) this.bodySources.serve.completed.delete(id)
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
	return toFileUrl(path)
}

function sameScriptPath(a: string, b: string): boolean {
	return a === b || normalizeScriptPath(a) === normalizeScriptPath(b)
}

function normalizeScriptPath(path: string): string {
	let normalized = path
	if (normalized.startsWith('file:')) {
		try { normalized = fileUrlToPath(normalized) } catch { /* preserve unknown script ids */ }
	}
	normalized = toPosixPath(normalized)
	const drive = normalized[0]
	if (drive !== undefined && /^[A-Za-z]:/.test(normalized)) return drive.toUpperCase() + normalized.slice(1)
	return normalized
}

function encodePath(path: string): string {
	return path.split('/').map(encodeURIComponent).join('/')
}
