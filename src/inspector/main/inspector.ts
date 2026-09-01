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

import { errMsg, log, type ModuleInfo } from '../../../cts/src/api'
import { type DebugChannelMain, native } from '../shared/native'
import { MainEndpoint } from '../transport/main-endpoint'
import { Evaluator } from './evaluator'
import { Hooks } from './hooks'
import { PauseController } from './pause-controller'
import { Serializer } from './remote-object'
import { registerRpcHandlers } from './rpc-handlers'

const worker = import.meta.use('worker')
const console = import.meta.use('console')
const timers = import.meta.use('timers')

type WorkerErrorPayload = { message: string; stack?: string; phase?: string }
type InspectorState = 'idle' | 'attaching' | 'active' | 'stopping'

/**
 * Loopback-only bind check. `0.0.0.0`/`::` are wildcards (every interface), and
 * anything else is a specific routable address; both are reachable off-box.
 *
 * This gates a warning that matters more than it looks: discovery is
 * unauthenticated by protocol necessity, so anyone who can reach the port can read
 * the token, and the token is arbitrary code execution. `--allow-*` is not enforced,
 * so the bind address and the token are the entire security model.
 */
export function isLoopbackHost(host: string): boolean {
	const h = host.trim().toLowerCase().replace(/^\[|\]$/g, '')
	if (h === '' || h === 'localhost') return true
	if (h === '::1') return true
	// IPv4-mapped loopback, e.g. ::ffff:127.0.0.1
	if (h.startsWith('::ffff:')) return isLoopbackHost(h.slice(7))
	return /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(h)
}

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

	private dc: DebugChannelMain | null = null
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
	private connectedWaiters = new Set<{ resolve: () => void; reject: (error: Error) => void }>()
	private runtimeReady = false
	private runtimeReadyWaiters = new Set<{ resolve: () => void; reject: (error: Error) => void }>()
	private stoppingWorker = false
	private state: InspectorState = 'idle'
	private generation = 0
	private stopPromise: Promise<void> | null = null
	private stopResolve: (() => void) | null = null
	private everConnected = false
	private disconnectError: Error | null = null

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
		const state = this.state ?? 'idle'
		if (state !== 'idle') throw new Error(`Inspector is already ${state}`)
		const generation = (this.generation ?? 0) + 1
		this.generation = generation
		this.state = 'attaching'
		this.stoppingWorker = false
		this.everConnected = false
		this.disconnectError = null
		this.stopPromise = new Promise<void>((resolve) => { this.stopResolve = resolve })
		let debugWorker: CModuleWorker.Worker | null = null
		const isCurrent = (): boolean => this.isCurrentSession(generation, debugWorker)
		let readyResolve!: (value: { wsUrl: string }) => void
		let readyReject!: (error: Error) => void
		try {
			// Independent debug channel (own rings + semaphores; never touches uv).
			const pair = native.createDebugChannel()
			this.dc = pair.dc
			// Create the readiness waiter before spawning the worker.
			let timeout: ReturnType<typeof timers.setTimeout> | null = null
			const ready = new Promise<{ wsUrl: string }>((resolve, reject) => {
				readyResolve = (value) => {
					if (timeout !== null) timers.clearTimeout(timeout)
					resolve(value)
				}
				readyReject = (error) => {
					if (timeout !== null) timers.clearTimeout(timeout)
					reject(error)
				}
				this.readyResolve = readyResolve
				this.readyReject = readyReject
				timeout = timers.setTimeout(
					() => readyReject(new Error('inspector attach timed out waiting for worker ready')),
					30_000,
				)
			})
			// Construction can fail before `ready` is awaited; keep that rejection observed.
			void ready.catch(() => {})

			debugWorker = new worker.Worker({
				__cno_debug_worker: true,
				port: this.port,
				host: this.host,
				channelHandle: pair.handle,
				entryFile: this.entryFile,
			})
			this.worker = debugWorker

			const endpoint = new MainEndpoint(debugWorker.messagePipe, pair.dc, {
				onMessageError: (error) => {
					if (!isCurrent()) return
					this.handleWorkerFailure(new Error(`inspector worker pipe failed: ${errMsg(error)}`), true, generation, debugWorker)
				},
				onClose: () => {
					if (isCurrent()) this.handleWorkerClosed(generation, debugWorker!)
				},
			})
			const serializer = new Serializer()
			const evaluator = new Evaluator(serializer)
			const hooks = new Hooks(endpoint, serializer)
			const pause = new PauseController(endpoint, serializer, () => this.connected, (file) => hooks.frameLocationFor(file))
			this.endpoint = endpoint
			this.serializer = serializer
			this.hooks = hooks

			registerRpcHandlers(endpoint, {
				serializer,
				evaluator,
				hooks,
				pauseController: pause,
				onReady: (q) => {
					if (!isCurrent()) return
					readyResolve({ wsUrl: q.wsUrl ?? `ws://127.0.0.1:${this.port}/ws/unknown` })
					if (this.readyResolve === readyResolve) this.readyResolve = null
					if (this.readyReject === readyReject) this.readyReject = null
				},
				onConnectedChange: (connected) => {
					if (!isCurrent()) return
					this.connected = connected
					if (connected) {
						this.everConnected = true
						this.disconnectError = null
						for (const waiter of this.connectedWaiters) waiter.resolve()
						this.connectedWaiters.clear()
					}
					if (!connected) {
						this.runtimeReady = false
						const error = new Error('DevTools client disconnected before the debugger became ready')
						if (this.everConnected) this.disconnectError = error
						for (const waiter of this.runtimeReadyWaiters) waiter.reject(error)
						this.runtimeReadyWaiters.clear()
						hooks.releasePendingIntercepts()
					}
				},
				onRuntimeReady: () => {
					if (!isCurrent()) return
					this.runtimeReady = true
					for (const waiter of this.runtimeReadyWaiters) waiter.resolve()
					this.runtimeReadyWaiters.clear()
				},
				onWorkerError: (error: WorkerErrorPayload) => {
					if (!isCurrent()) return
					const phase = error.phase ? ` during ${error.phase}` : ''
					log.error('inspector', () => `debug worker crashed${phase}: ${errMsg(error)}`)
					const workerError = new Error(`inspector worker failed${phase}: ${error.message}`)
					this.handleWorkerFailure(workerError, true, generation, debugWorker)
				},
			})
			this.inspectorUrl = (await ready).wsUrl
			if (!isCurrent()) throw new Error('Inspector stopped while waiting for worker ready')
			console.info(`Debugger listening on ${this.inspectorUrl}`)
			console.info(`Visit chrome://inspect to connect to the debugger.`)
			if (!isLoopbackHost(this.host)) {
				// Discovery (/json/version) is unauthenticated by protocol necessity, so it
				// hands the ws token to anyone who can reach the port, and the ws session is
				// arbitrary code execution. On a non-loopback bind that is the whole network.
				console.warn(
					`Warning: inspector bound to ${this.host}:${this.port}, which is not loopback. `
					+ `Anyone able to reach it can read the debugger token from /json/version and run `
					+ `arbitrary code in this process. Bind 127.0.0.1 and use an SSH tunnel instead.`,
				)
			}

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
			if (!isCurrent()) throw new Error('Inspector stopped while attaching')
			this.state = 'active'
		} catch (error) {
			const failure = error instanceof Error ? error : new Error(String(error))
			this.beginStop(generation, debugWorker, failure)
			throw error
		}
	}

	waitForConnection(timeoutMs?: number): Promise<void> {
		if (this.connected) return Promise.resolve()
		if ((this.state ?? 'idle') === 'stopping') return Promise.reject(new Error('Inspector is stopping'))
		return new Promise<void>((resolve, reject) => {
			let timeout: ReturnType<typeof timers.setTimeout> | null = null
			const waiter = {
				resolve: (): void => {
					if (timeout != null) timers.clearTimeout(timeout)
					this.connectedWaiters.delete(waiter)
					resolve()
				},
				reject: (error: Error): void => {
					if (timeout != null) timers.clearTimeout(timeout)
					this.connectedWaiters.delete(waiter)
					reject(error)
				},
			}
			this.connectedWaiters.add(waiter)
			if (timeoutMs && timeoutMs > 0) {
				timeout = timers.setTimeout(() => {
					waiter.reject(new Error('timed out waiting for DevTools client'))
				}, timeoutMs)
			}
		})
	}

	waitForDebugger(): Promise<void> {
		if (this.runtimeReady) return Promise.resolve()
		if ((this.state ?? 'idle') === 'stopping') return Promise.reject(new Error('Inspector is stopping'))
		if (!this.connected && this.disconnectError) return Promise.reject(this.disconnectError)
		return new Promise<void>((resolve, reject) => {
			this.runtimeReadyWaiters.add({ resolve, reject })
		})
	}

	/** Let a completed entry exit while leaving inspection live for other handles. */
	allowProcessExit(): void {
		this.worker?.messagePipe.unref()
	}

	async detach(): Promise<void> {
		const state = this.state ?? 'idle'
		if (state === 'idle') {
			this.rejectWaiters(new Error('Inspector stopped before the requested state was reached'))
			return
		}
		const promise = this.beginStop(this.generation, this.worker, new Error('Inspector detached'))
		if (promise) await promise
	}

	/**
	 * Synchronous force-stop for Ctrl+X path.
	 */
	forceStop(): void {
		const state = this.state ?? 'idle'
		if (state === 'idle') {
			this.rejectWaiters(new Error('Inspector stopped before the requested state was reached'))
			return
		}
		const generation = this.generation
		const debugWorker = this.worker
		this.beginStop(generation, debugWorker, new Error('Inspector force-stopped'))
		// This path is explicitly synchronous (Ctrl-C/TTY shutdown). It may join
		// a worker that ignores stop(), unlike the normal asynchronous detach path.
		if (debugWorker && this.state === 'stopping') this.completeStop(generation, debugWorker, true)
	}

	private stopInfrastructure(): void {
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
	}

	private rejectWaiters(error: Error): void {
		const rejectReady = this.readyReject
		this.readyResolve = null
		this.readyReject = null
		rejectReady?.(error)
		for (const waiter of this.connectedWaiters) waiter.reject(error)
		this.connectedWaiters.clear()
		for (const waiter of this.runtimeReadyWaiters) waiter.reject(error)
		this.runtimeReadyWaiters.clear()
	}

	private isCurrentSession(generation: number, debugWorker: CModuleWorker.Worker | null): boolean {
		const state = this.state ?? 'idle'
		return this.generation === generation
			&& this.worker === debugWorker
			&& (state !== 'idle' || debugWorker !== null)
	}

	private beginStop(
		generation: number,
		debugWorker: CModuleWorker.Worker | null,
		error: Error,
	): Promise<void> | null {
		if (!this.isCurrentSession(generation, debugWorker)) {
			return this.state === 'stopping' ? this.stopPromise : null
		}
		if (this.state !== 'stopping') {
			this.state = 'stopping'
			this.stoppingWorker = true
			this.stopInfrastructure()
			this.rejectWaiters(error)
			this.connected = false
			this.runtimeReady = false
			this.inspectorUrl = ''
			this.scriptInitHook = undefined
		}
		if (!debugWorker) {
			this.reset(generation, null)
			return null
		}
		// stop() only signals the worker. The current session's close callback
		// performs the synchronous join after the peer has reached EOF.
		try { debugWorker.stop() } catch { /* already gone */ }
		try { debugWorker.messagePipe.unref() } catch { /* already closed */ }
		return this.stopPromise
	}

	private handleWorkerFailure(
		error: Error,
		stopWorker = true,
		generation?: number,
		debugWorker?: CModuleWorker.Worker | null,
	): void {
		const currentGeneration = generation ?? this.generation
		const currentWorker = debugWorker === undefined ? this.worker : debugWorker
		if (generation !== undefined && !this.isCurrentSession(currentGeneration, currentWorker)) return
		if (stopWorker) void this.beginStop(currentGeneration, currentWorker, error)
	}

	private handleWorkerClosed(
		generationOrWorker: number | CModuleWorker.Worker,
		workerArg?: CModuleWorker.Worker,
	): void {
		const generation = typeof generationOrWorker === 'number' ? generationOrWorker : this.generation
		const debugWorker = typeof generationOrWorker === 'number' ? workerArg : generationOrWorker
		if (!debugWorker || !this.isCurrentSession(generation, debugWorker)) return
		if (this.state !== 'stopping') {
			this.beginStop(generation, debugWorker, new Error('inspector worker stopped unexpectedly'))
		}
		this.completeStop(generation, debugWorker, true)
	}

	private completeStop(
		generation: number,
		debugWorker: CModuleWorker.Worker | null,
		join: boolean,
	): void {
		if (!this.isCurrentSession(generation, debugWorker)) return
		if (debugWorker) {
			try { debugWorker.messagePipe.onclose = undefined } catch { /* already closed */ }
			try { debugWorker.messagePipe.onmessage = undefined } catch { /* already closed */ }
			try { debugWorker.messagePipe.onmessageerror = undefined } catch { /* already closed */ }
			if (join) {
				// EOF or an explicit force-stop makes this the only remaining join site.
				try { debugWorker.terminate() } catch { /* already reaped */ }
			}
		}
		this.reset(generation, debugWorker)
	}

	private reset(generation = this.generation, debugWorker: CModuleWorker.Worker | null = this.worker): void {
		if (generation !== this.generation || (debugWorker !== null && this.worker !== debugWorker)) return
		this.worker = null
		this.endpoint = null
		this.dc = null
		this.serializer = null
		this.hooks = null
		const terminationError = new Error('Inspector stopped before the requested state was reached')
		this.rejectWaiters(terminationError)
		this.connected = false
		this.runtimeReady = false
		this.stoppingWorker = false
		this.state = 'idle'
		this.disconnectError = null
		this.everConnected = false
		this.inspectorUrl = ''
		this.scriptInitHook = undefined
		const resolveStop = this.stopResolve
		this.stopResolve = null
		this.stopPromise = null
		resolveStop?.()
	}
}
