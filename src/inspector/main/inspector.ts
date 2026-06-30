/**
 * main/inspector.ts — the public composition root, running on the main thread.
 *
 *   DevTools ⇄ Worker (WS + CDP) ⇄ [this: main-thread app]
 *
 * The main thread is the sole authority for JS execution and inspection. This
 * class wires the pieces together — endpoint (pipe + channel transports),
 * serializer/object-store, evaluator, network/script hooks, and the pause
 * controller — then exposes the small lifecycle contract that commands/run.ts
 * and the REPL consume: attach(), detach(), inspectorUrl and
 * scriptInitHook.
 */

import { native } from '../shared/native'
import { MainEndpoint } from '../transport/main-endpoint'
import { Serializer } from './remote-object'
import { Evaluator } from './evaluator'
import { Hooks } from './hooks'
import { PauseController } from './pause-controller'
import { registerRpcHandlers } from './rpc-handlers'
import type { ModuleInfo } from '../../../cts/src/types'

const worker = import.meta.use('worker')
const console = import.meta.use('console')
const timers = import.meta.use('timers')

type WorkerErrorPayload = { message: string; stack?: string; phase?: string }

export interface InspectorOptions {
	port: number
	host?: string
	entryFile: string
	breakOnStart?: boolean
	waitForClient?: boolean
}

export class Inspector {
	private readonly port: number
	private readonly host: string
	private readonly entryFile: string
	private readonly breakOnStart: boolean
	private readonly waitForClient: boolean

	private dc: import('../shared/native').DebugChannelMain | null = null
	private worker: CModuleWorker.Worker | null = null
	private endpoint: MainEndpoint | null = null
	private serializer: Serializer | null = null
	private hooks: Hooks | null = null

	/** Live DevTools connection state — read by the pause controller. */
	private connected = false

	/** ws:// URL of the worker's DevTools endpoint; populated during attach(). */
	inspectorUrl = ''

	private readyResolve: ((v: { wsUrl: string }) => void) | null = null
	private readyReject: ((e: Error) => void) | null = null
	private connectedResolve: (() => void) | null = null
	private runtimeReady = false
	private runtimeReadyResolve: (() => void) | null = null

	/** Script-init hook; run.ts wires this into runtime.addInitHook() after attach. */
	scriptInitHook?: (specPath: string, info: ModuleInfo) => void

	constructor(opts: InspectorOptions) {
		this.port = opts.port
		this.host = opts.host ?? '127.0.0.1'
		this.entryFile = opts.entryFile
		this.breakOnStart = opts.breakOnStart ?? false
		this.waitForClient = opts.waitForClient ?? false
	}

	async attach(): Promise<void> {
		// Independent debug channel (own rings + semaphores; never touches uv).
		const pair = native.createDebugChannel()
		this.dc = pair.dc

		this.worker = new worker.Worker({
			__cno_debug_worker: true,
			port: this.port,
			host: this.host,
			channelHandle: pair.handle,
			entryFile: this.entryFile,
		})
		this.worker.messagePipe.onmessageerror = (error: unknown) => {
			console.error('[inspector] debug worker pipe error:', error)
		}

		const endpoint = new MainEndpoint(this.worker.messagePipe, pair.dc)
		const serializer = new Serializer()
		const evaluator = new Evaluator(serializer)
		const hooks = new Hooks(endpoint, serializer)
		const pause = new PauseController(endpoint, serializer, () => this.connected)
		this.endpoint = endpoint
		this.serializer = serializer
		this.hooks = hooks

		registerRpcHandlers(endpoint, {
			serializer,
			evaluator,
			hooks,
			pauseController: pause,
			onReady: (q) => {
				this.readyResolve?.({ wsUrl: q.wsUrl ?? `ws://127.0.0.1:${this.port}/ws/unknown` })
				this.readyResolve = null
				this.readyReject = null
			},
			onConnectedChange: (connected) => {
				this.connected = connected
				if (connected) {
					this.connectedResolve?.()
					this.connectedResolve = null
				}
				if (!connected) {
					this.runtimeReady = false
					this.runtimeReadyResolve = null
				}
			},
			onRuntimeReady: () => {
				this.runtimeReady = true
				this.runtimeReadyResolve?.()
				this.runtimeReadyResolve = null
			},
			onWorkerError: (error: WorkerErrorPayload) => {
				const phase = error.phase ? ` during ${error.phase}` : ''
				console.error(`[inspector] debug worker crashed${phase}: ${error.message}`)
				if (error.stack) console.error(error.stack)
			},
		})
		// Wait for the worker's WS server to report its URL via the ready RPC.
		const ready = await new Promise<{ wsUrl: string }>((resolve, reject) => {
			this.readyResolve = resolve
			this.readyReject = reject
			const timeout = timers.setTimeout(() => reject(new Error('inspector attach timed out waiting for worker ready')), 30_000)
			this.readyResolve = (value) => {
				timers.clearTimeout(timeout)
				resolve(value)
			}
			this.readyReject = (error) => {
				timers.clearTimeout(timeout)
				reject(error)
			}
		})
		this.inspectorUrl = ready.wsUrl
		console.info(`Debugger listening on ${this.inspectorUrl}`)
		console.info(`Visit chrome://inspect to connect to the debugger.`)

		// Hooks must be live before the entry module is loaded.
		hooks.installAll()
		this.scriptInitHook = hooks.scriptInitHook ?? undefined

		// onBreak runs at the next safepoint; the worker triggers it via dc.interrupt().
		native.start(
			(r: number, fp: string | undefined, fn: string | undefined, l: number, c: number, thrown?: unknown) =>
				pause.onBreak(r, fp ?? '', fn ?? '', l, c, thrown),
		)

		if (this.breakOnStart || this.waitForClient) {
			console.warn('Waiting for DevTools client...')
			await this.waitForConnection(30_000)
			if (this.breakOnStart) {
				try {
					native.addBreakpoint(this.entryFile, 1)
				} catch {
					/* entry not yet known to the debugger */
				}
			}
			if (this.waitForClient) {
				await this.waitForDebugger()
			}
		}
	}

	waitForConnection(timeoutMs?: number): Promise<void> {
		if (this.connected) return Promise.resolve()
		return new Promise<void>((resolve, reject) => {
			let timeout: unknown = null
			if (timeoutMs && timeoutMs > 0) {
				timeout = timers.setTimeout(() => {
					if (this.connectedResolve === onConnected) this.connectedResolve = null
					reject(new Error('timed out waiting for DevTools client'))
				}, timeoutMs)
			}
			const onConnected = (): void => {
				if (timeout != null) timers.clearTimeout(timeout as number)
				resolve()
			}
			this.connectedResolve = onConnected
		})
	}

	waitForDebugger(): Promise<void> {
		if (this.runtimeReady) return Promise.resolve()
		return new Promise<void>((resolve) => {
			this.runtimeReadyResolve = resolve
		})
	}

	async detach(): Promise<void> {
		try {
			native.stop()
		} catch {
			/* ignore */
		}
		try {
			this.dc?.stop()
		} catch {
			/* ignore */
		}
		this.serializer?.releaseGroup('backtrace')
		this.hooks?.teardown()
		this.worker?.terminate()
		this.reset()
	}

	/**
	 * Synchronous force-stop for Ctrl+X path.
	 */
	forceStop(): void {
		try {
			native.stop()
		} catch {
			/* ignore */
		}
		try {
			this.dc?.stop()
		} catch {
			/* ignore */
		}
		this.serializer?.releaseGroup('backtrace')
		this.hooks?.teardown()
		this.reset()
	}

	private reset(): void {
		this.worker = null
		this.endpoint = null
		this.dc = null
		this.serializer = null
		this.hooks = null
		this.readyResolve = null
		this.readyReject = null
		this.connectedResolve = null
		this.connected = false
		this.runtimeReady = false
		this.runtimeReadyResolve = null
	}
}
