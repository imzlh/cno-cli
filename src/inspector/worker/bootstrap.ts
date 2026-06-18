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
	channelHandle: ArrayBuffer
	entryFile?: string
	__cno_debug_worker: true
}

function toEntryUrl(entryFile?: string): string {
	if (!entryFile) return 'about:blank'
	const normalized = entryFile.replace(/\\/g, '/').replace(/^\//, '')
	return normalized[0] == '/' ? `file://${normalized}` : `file:///${normalized}`
}

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
	const pageDomain = new PageDomain(dispatcher, emit)
	const networkDomain = new NetworkDomain(dispatcher, emit)
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
	}).then(({ wsUrl }) => {
		void endpoint.call('ready', { wsUrl })
	})
}

bootstrapDebugWorker()
