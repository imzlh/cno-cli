/**
 * main/inspector.ts — the public composition root, running on the main thread.
 *
 *   DevTools ⇄ Worker (WS + CDP) ⇄ [this: main-thread app]
 *
 * The main thread is the sole authority for JS execution and inspection. This
 * class wires the pieces together — endpoint (pipe + channel transports),
 * serializer/object-store, evaluator, network/script hooks, and the pause
 * controller — then exposes the small lifecycle contract that commands/run.ts
 * and the REPL consume: attach(), detach(), forceStop(), inspectorUrl and
 * scriptInitHook.
 */

import { native } from '../shared/native'
import { MainEndpoint } from '../transport/main-endpoint'
import { Serializer } from './remote-object'
import { Evaluator } from './evaluator'
import { Hooks } from './hooks'
import { PauseController } from './pause-controller'
import { registerRpcHandlers } from './rpc-handlers'
import { log } from '../../../cts/src/utils/log'

const worker = import.meta.use('worker')
const console = import.meta.use('console')
const timers = import.meta.use('timers')

export interface InspectorOptions {
	port: number
	entryFile: string
	breakOnStart?: boolean
	waitForClient?: boolean
}

export class Inspector {
	private readonly port: number
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

	/** Script-init hook; run.ts wires this into runtime.addInitHook() after attach. */
	scriptInitHook?: (specPath: string) => void

	constructor(opts: InspectorOptions) {
		this.port = opts.port
		this.entryFile = opts.entryFile
		this.breakOnStart = opts.breakOnStart ?? false
		this.waitForClient = opts.waitForClient ?? false
	}

	async attach(): Promise<void> {
		log.debug('debug', () => `inspector.attach: port=${this.port} entry=${this.entryFile}`)

		// Independent debug channel (own rings + semaphores; never touches uv).
		const pair = native.createDebugChannel()
		this.dc = pair.dc

		this.worker = new worker.Worker({
			__cno_debug_worker: true,
			port: this.port,
			channelHandle: pair.handle,
			entryFile: this.entryFile,
		})

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
			},
		})
		log.debug('debug', () => 'inspector: worker spawned, RPC handlers registered')

		// Wait for the worker's WS server to report its URL via the ready RPC.
		const ready = await new Promise<{ wsUrl: string }>((resolve, reject) => {
			this.readyResolve = resolve
			this.readyReject = reject
			timers.setTimeout(() => reject(new Error('inspector attach timed out waiting for worker ready')), 30_000)
		})
		this.inspectorUrl = ready.wsUrl
		log.debug('debug', () => `inspector: worker ready at ${this.inspectorUrl}`)

		// Hooks must be live before the entry module is loaded.
		hooks.installAll()
		this.scriptInitHook = hooks.scriptInitHook ?? undefined

		// onBreak runs at the next safepoint; the worker triggers it via dc.interrupt().
		native.start(
			(r: number, fp: string | undefined, fn: string | undefined, l: number, c: number) =>
				pause.onBreak(r, fp ?? '', fn ?? '', l, c),
		)

		if (this.breakOnStart || this.waitForClient) {
			console.warn('Waiting for DevTools client...')
			await new Promise<void>((resolve) => {
				this.connectedResolve = resolve
				timers.setTimeout(() => resolve(), 30_000)
			})
			if (this.breakOnStart) {
				try {
					native.addBreakpoint(this.entryFile, 1)
				} catch {
					/* entry not yet known to the debugger */
				}
			}
		}
	}

	async detach(): Promise<void> {
		log.debug('debug', () => 'inspector.detach')
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
	 * Synchronous force-stop for the SIGINT path: unsticks the main thread when
	 * it is frozen inside the paused service loop. Never terminates the worker
	 * (that can deadlock in a signal handler); os.exit() reaps all threads.
	 */
	forceStop(): void {
		log.debug('debug', () => 'inspector.forceStop')
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
	}
}
