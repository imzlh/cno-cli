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
	type FetchRequestInfo,
	type FetchResponseInfo,
	type FetchDataInfo,
	type FetchFinishedInfo,
	type InterceptResult,
} from '../../../cno/src/utils/network-hooks'
import {
	NetFetchKind,
	NetWSKind,
	WorkerEvent,
	type BindingCalledPayload,
	type ConsolePayload,
	type FetchInterceptPayload,
	type LoadPayload,
	type NetFetchData,
	type NetFetchDone,
	type NetFetchReq,
	type NetFetchRes,
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

type LoadCapableGlobal = {
	addEventListener?: (type: string, cb: () => void, opts?: { once?: boolean }) => void
}

const kOrigin = Symbol('console.origin')

export class Hooks {
	private readonly pendingIntercepts = new Map<string, (result: InterceptResult | null) => void>()
	private readonly installedBindings = new Set<string>()
	private scriptHookInstalled = false
	private consoleOriginals: Record<string, (...a: unknown[]) => void> | null = null

	/** Set by installScript(); run.ts wires this into runtime.addInitHook(). */
	scriptInitHook: ((specPath: string) => void) | null = null

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
		this.scriptInitHook = (specPath: string) => {
			// DevTools groups scripts by domain, so a path needs a URL scheme.
			// [A-Za-z] avoids matching Windows drive letters (D:) as a scheme.
			const url = /^[A-Za-z]{2,}:/.test(specPath) ? specPath : `file:///${specPath.replace(/\\/g, '/').replace(/^\//, '')}`
			let length = 0
			let endLine = 0
			try {
				const buf = fs.readFile(specPath)
				length = buf.byteLength
				const str = engine.decodeString(buf)
				endLine = (str.match(/\n/g) ?? []).length
			} catch {
				/* unreadable source \u2014 report zero length */
			}
			this.safeEmit(WorkerEvent.ScriptParsed, { scriptId: specPath, url, length, endLine } satisfies ScriptParsedPayload)
		}
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

		setWebSocketHook({
			onCreated: (i) =>
				this.safeEmit(WorkerEvent.NetWs, {
					ev: NetWSKind.Created,
					requestId: i.requestId,
					url: i.url,
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
				orig.apply(globalThis.console, args)
				try {
					const serialized = args.map(a => this.serializer.serialize(a, 'console', { preview: true }))
					this.safeEmit(WorkerEvent.Console, { method: cdpType, args: serialized } satisfies ConsolePayload)
				} catch { /* ignore serialization errors */ }
			}
		}
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
	}

	private safeEmit(ev: WorkerEvent, params: unknown): void {
		try {
			this.endpoint.emit(ev, params)
		} catch {
			/* worker gone */
		}
	}
}
