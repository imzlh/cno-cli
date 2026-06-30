/**
 * worker/bootstrap.ts — composition root that runs inside the debug worker.
 *
 * Wiring only, no logic: acquire the debug channel + message pipe, build the
 * WorkerEndpoint, instantiate every CDP domain on a shared dispatcher, point
 * the endpoint's event stream at the router, then start the DevTools server and
 * announce its URL back to the main thread via the `ready` lifecycle RPC.
 *
 * The `__cno_debug_worker: true` flag in workerData is what the runtime uses to
 * recognise this worker; it is set by the main-thread Inspector, not here.
 */

import { native, type DebugChannelWorker } from '../shared/native'
import { toPosixPath } from '../../../cts/src/utils/path'
import { WorkerEndpoint } from '../transport/worker-endpoint'
import { CDPDispatcher } from './dispatcher'
import { CdpChannel, handleDevToolsConnection } from './connection'
import { createEventRouter } from './event-router'
import { startServer } from './server'
import { DebuggerDomain } from '../domains/debugger'
import { RuntimeDomain } from '../domains/runtime'
import { ConsoleDomain } from '../domains/console'
import { PageDomain } from '../domains/page'
import { NetworkDomain } from '../domains/network'
import { FetchDomain } from '../domains/fetch'
import { TargetDomain } from '../domains/target'

const worker = import.meta.use('worker');

interface DebugWorkerData {
	port: number
	host?: string
	channelHandle: ArrayBuffer
	entryFile?: string
	__cno_debug_worker: true
}

type WorkerErrorReport = {
	message: string
	stack?: string
	phase?: string
}

function toEntryUrl(entryFile?: string): string {
	if (!entryFile) return 'about:blank'
	const normalized = toPosixPath(entryFile).replace(/^\//, '')
	return normalized[0] == '/' ? `file://${normalized}` : `file:///${normalized}`
}

function reportWorkerError(report: WorkerErrorReport): void {
	try {
		const workerData = worker.workerData as DebugWorkerData
		const dc: DebugChannelWorker = native.getDebugChannel(workerData.channelHandle)
		if (!worker.pipe) return
		const endpoint = new WorkerEndpoint(worker.pipe, dc)
		void endpoint.call('workerError', report)
	} catch {
		// Ignore secondary reporting failures; preserving the original error matters more.
	}
}

globalThis.addEventListener?.('error', (event) => {
	const errEvent = event as ErrorEvent
	const error = errEvent.error instanceof Error ? errEvent.error : undefined
	reportWorkerError({
		message: errEvent.message || error?.message || 'Unknown worker error',
		stack: error?.stack,
		phase: 'global error',
	})
})

globalThis.addEventListener?.('unhandledrejection', (event) => {
	const rejection = event as PromiseRejectionEvent
	const reason = rejection.reason
	const error = reason instanceof Error ? reason : new Error(String(reason))
	reportWorkerError({
		message: error.message,
		stack: error.stack,
		phase: 'unhandledrejection',
	})
})

export function bootstrapDebugWorker(): void {
	const { pipe } = worker
	const workerData = worker.workerData as DebugWorkerData

	const dc: DebugChannelWorker = native.getDebugChannel(workerData.channelHandle)
	const entryUrl = toEntryUrl(workerData.entryFile)

	if (!pipe) throw new Error('debug worker: worker pipe not available')

	const endpoint = new WorkerEndpoint(pipe, dc)
	const dispatcher = new CDPDispatcher()
	const channel = new CdpChannel()
	const emit = channel.emit

	const debuggerDomain = new DebuggerDomain(dispatcher, emit, endpoint)
	const runtimeDomain = new RuntimeDomain(dispatcher, emit, endpoint)
	const consoleDomain = new ConsoleDomain(dispatcher, emit)
	const pageDomain = new PageDomain(dispatcher, emit, endpoint)
	const networkDomain = new NetworkDomain(dispatcher, emit, endpoint)
	const fetchDomain = new FetchDomain(dispatcher, emit, endpoint)
	const targetDomain = new TargetDomain(dispatcher, emit)
	targetDomain.setEntryUrl(entryUrl)

	endpoint.onEvent = createEventRouter({
		endpoint,
		emit,
		debuggerDomain,
		runtimeDomain,
		consoleDomain,
		pageDomain,
		networkDomain,
		fetchDomain,
	})

	void startServer({
		port: workerData.port,
		host: workerData.host,
		entryUrl,
		onConnect: (ws) =>
			handleDevToolsConnection(ws, {
				channel,
				dispatcher,
				rpc: endpoint,
				entryUrl,
				debuggerDomain,
				runtimeDomain,
				pageDomain,
			}),
	}).then((handle) => {
		const { wsUrl } = handle
		globalThis.addEventListener?.('exit', () => handle.close?.(), { once: true })
		void endpoint.call('ready', { wsUrl })
	}).catch((error) => {
		const err = error instanceof Error ? error : new Error(String(error))
		reportWorkerError({
			message: err.message,
			stack: err.stack,
			phase: 'startServer',
		})
		throw err
	})
}

try {
	bootstrapDebugWorker()
} catch (error) {
	const err = error instanceof Error ? error : new Error(String(error))
	reportWorkerError({
		message: err.message,
		stack: err.stack,
		phase: 'bootstrap',
	})
	throw err
}
