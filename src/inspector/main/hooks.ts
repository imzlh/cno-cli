/**
 * main/hooks.ts — bridge native main-thread signals into worker events.
 *
 * Installs the script-init, fetch/websocket/intercept, lifecycle and binding
 * hooks. Each callback normalizes the native info object into a typed wire
 * payload (see shared/wire.ts) and forwards it to the worker. The script-init
 * hook is exposed (not auto-installed) so run.ts can register it on the runtime.
 */

import {
	setFetchHook,
	setWebSocketHook,
	setFetchInterceptHook,
	setServeHook,
	type FetchRequestInfo,
	type FetchResponseInfo,
	type FetchDataInfo,
	type FetchFinishedInfo,
	type ServeRequestInfo,
	type ServeResponseInfo,
	type ServeDataInfo,
	type ServeFinishedInfo,
	type InterceptResult,
} from '../../../cno/src/utils/network-hooks'
import {
	NetFetchKind,
	NetServeKind,
	NetWSKind,
	WorkerEvent,
	type BindingCalledPayload,
	type ConsolePayload,
	type ConsoleCallFrame,
	type FetchInterceptPayload,
	type LoadPayload,
	type NetFetchData,
	type NetFetchDone,
	type NetFetchReq,
	type NetFetchRes,
	type NetServeData,
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
import type { ModuleInfo } from '../../../cts/src/types'
import { native } from '../shared/native'
import { isUserFile } from '../shared/user-files'

const engine = import.meta.use('engine')
const fs = import.meta.use('fs')
const console = import.meta.use('console')

type LoadCapableGlobal = {
	addEventListener?: (type: string, cb: () => void, opts?: { once?: boolean }) => void
}

const kOrigin = Symbol('console.origin')

export class Hooks {
	private readonly pendingIntercepts = new Map<string, (result: InterceptResult | null) => void>()
	private readonly installedBindings = new Set<string>()
	private readonly scriptSourcePaths = new Map<string, string>()
	private scriptHookInstalled = false
	private consoleOriginals: Record<string, (...a: unknown[]) => void> | null = null

	/** Set by installScript(); run.ts wires this into runtime.addInitHook(). */
	scriptInitHook: ((specPath: string, info: ModuleInfo) => void) | null = null

	constructor(private readonly endpoint: MainEndpoint, private readonly serializer: Serializer) {}

	installAll(): void {
		this.installScript()
		this.installNetwork()
		this.installLifecycle()
		this.installConsole()
	}

	// script
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
				length = buf.byteLength
				const str = engine.decodeString(buf)
				endLine = (str.match(/\n/g) ?? []).length
			} catch {
				/* unreadable source \u2014 report zero length */
			}
			this.safeEmit(WorkerEvent.ScriptParsed, { scriptId: specPath, url, sourcePath, length, endLine } satisfies ScriptParsedPayload)
		}
	}

	scriptSourcePath(scriptId: string): string {
		return this.scriptSourcePaths.get(scriptId) ?? scriptId
	}

	private scriptFrameLocation(file: string): { scriptId: string; url: string } {
		for (const [specPath, sourcePath] of this.scriptSourcePaths) {
			if (sameScriptPath(file, specPath) || sameScriptPath(file, sourcePath)) {
				return { scriptId: specPath, url: devtoolsScriptUrl(specPath, sourcePath) }
			}
		}
		return { scriptId: file, url: devtoolsScriptUrl(file, file) }
	}

	//  network 
private installNetwork(): void {
		setFetchHook({
			onRequest: (i: FetchRequestInfo) =>
				this.safeEmit(WorkerEvent.NetFetch, {
					ev: NetFetchKind.Req,
					requestId: i.requestId,
					timestamp: i.timestamp,
					url: i.url,
					method: i.method,
					headers: i.headers,
					postData: i.postData ?? undefined,
					callFrames: i.callFrames,
					resourceType: i.resourceType,
				} satisfies NetFetchReq),
			onResponse: (i: FetchResponseInfo) =>
				this.safeEmit(WorkerEvent.NetFetch, {
					ev: NetFetchKind.Res,
					requestId: i.requestId,
					timestamp: i.timestamp,
					url: i.url,
					status: i.status,
					headers: i.headers,
					requestHeaders: i.requestHeaders,
					resourceType: i.resourceType,
					connection: i.connection,
				} satisfies NetFetchRes),
			onData: (i: FetchDataInfo) =>
				this.safeEmit(WorkerEvent.NetFetch, {
					ev: NetFetchKind.Data,
					requestId: i.requestId,
					timestamp: i.timestamp,
					data: i.data,
					byteLength: i.data.byteLength,
				} satisfies NetFetchData),
			onFinished: (i: FetchFinishedInfo) =>
				this.safeEmit(WorkerEvent.NetFetch, {
					ev: NetFetchKind.Done,
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
					requestId: i.requestId,
					timestamp: i.timestamp,
					url: i.url,
					method: i.method,
					headers: i.headers,
					postData: i.postData ?? undefined,
					callFrames: i.callFrames,
				} satisfies NetServeReq),
			onResponse: (i: ServeResponseInfo) =>
				this.safeEmit(WorkerEvent.NetServe, {
					ev: NetServeKind.Res,
					requestId: i.requestId,
					timestamp: i.timestamp,
					url: i.url,
					status: i.status,
					statusText: i.statusText,
					headers: i.headers,
				} satisfies NetServeRes),
			onData: (i: ServeDataInfo) =>
				this.safeEmit(WorkerEvent.NetServe, {
					ev: NetServeKind.Data,
					requestId: i.requestId,
					timestamp: i.timestamp,
					data: i.data,
					byteLength: i.data.byteLength,
				} satisfies NetServeData),
			onFinished: (i: ServeFinishedInfo) =>
				this.safeEmit(WorkerEvent.NetServe, {
					ev: NetServeKind.Done,
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
					requestId: i.requestId,
					url: i.url,
					requestHeaders: i.requestHeaders,
					callFrames: i.callFrames,
					timestamp: i.timestamp,
				} satisfies NetWSCreated),
			onHandshake: (i) =>
				this.safeEmit(WorkerEvent.NetWs, {
					ev: NetWSKind.Handshake,
					requestId: i.requestId,
					status: i.status,
					headers: i.headers,
					timestamp: i.timestamp,
				} satisfies NetWSHandshake),
			onFrameReceived: (i) =>
				this.safeEmit(WorkerEvent.NetWs, {
					ev: NetWSKind.Recv,
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

	/** Resolve a pending interception (called from the fetchInterceptResult RPC). */
	resolveIntercept(requestId: string, result: InterceptResult | null): void {
		const resolve = this.pendingIntercepts.get(requestId)
		if (!resolve) return
		this.pendingIntercepts.delete(requestId)
		resolve(result)
	}

	//  lifecycle 
	private installLifecycle(): void {
		const add = (globalThis as LoadCapableGlobal).addEventListener
		add?.(
			'load',
			() => this.safeEmit(WorkerEvent.Load, { timestamp: Date.now() / 1000 } satisfies LoadPayload),
			{ once: true },
		)
	}

	//  console
	private installConsole(): void {
		const con = globalThis.console;
		const methods = ['log', 'warn', 'error', 'info', 'debug', 'dir', 'trace'] as const
		const originals: Record<string, (...a: unknown[]) => void> = {}
		for (const m of methods) {
			if (typeof con[m] === 'function') originals[m] = con[m];
		}
		// Saved here so log.ts can bypass the hook for internal messages.
		Reflect.set(con, kOrigin, originals);
		this.consoleOriginals = originals

		for (const method of methods) {
			const orig = originals[method]
			if (!orig) continue
			// CDP uses 'warning' not 'warn'.
			const cdpType = method === 'warn' ? 'warning' : method
			con[method] = (...args: unknown[]) => {
				const callFrames = this.captureConsoleCallFrames()
				orig.apply(globalThis.console, args)
				try {
					const serialized = args.map(a => this.serializer.serialize(a, 'console', { preview: true }))

					this.safeEmit(WorkerEvent.Console, {
						method: cdpType,
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

	//  bindings
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

	//  teardown
	teardown(): void {
		// Resolve all pending intercepts so native hooks don't hang.
		for (const resolve of this.pendingIntercepts.values()) resolve(null)
		this.pendingIntercepts.clear()
		this.installedBindings.clear()
		this.scriptSourcePaths.clear()
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
	}

	private safeEmit(ev: WorkerEvent, params: unknown): void {
		try {
			this.endpoint.emit(ev, params)
		} catch {
			/* worker gone */
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
	const normalized = path.replace(/\\/g, '/').replace(/^\//, '')
	return `file:///${normalized}`
}

function sameScriptPath(a: string, b: string): boolean {
	return a === b || normalizeScriptPath(a) === normalizeScriptPath(b)
}

function normalizeScriptPath(path: string): string {
	let normalized = path.replace(/\\/g, '/')
	if (normalized.startsWith('file:///')) normalized = normalized.slice('file:///'.length)
	if (/^[A-Za-z]:/.test(normalized)) return normalized[0]!.toUpperCase() + normalized.slice(1)
	return normalized
}

function encodePath(path: string): string {
	return path.split('/').map(encodeURIComponent).join('/')
}
