/**
 * worker/connection.ts — binds one DevTools WebSocket to the CDP dispatcher.
 *
 * Exactly one DevTools client is active at a time. `CdpChannel` is the mutable
 * seam between “whoever is connected” and the domains: domains call
 * `channel.emit(...)` unconditionally, and the channel forwards to the current
 * socket (or drops the event when nobody is attached). On connect we flip every
 * domain to connected and tell the main thread; on disconnect we reverse it,
 * but only if *this* socket is still the active one (guards against a stale
 * close racing a fresh connection).
 */

import { isRecord, parseCDPMessage, type CDPMessage } from '../shared/cdp'
import { CDPError, CdpErrorCode, formatCdpError, type EmitEvent, type CDPDispatcher, type CdpParams } from './dispatcher'
import type { WorkerEndpoint } from '../transport/worker-endpoint'
import type { DebuggerDomain } from '../domains/debugger'
import type { RuntimeDomain } from '../domains/runtime'

const engine = import.meta.use('engine');

type CdpSink = (msg: CDPMessage) => void

/** Routes domain events to the currently-attached DevTools socket, if any. */
export class CdpChannel {
	private sink: CdpSink | null = null

	setSink(sink: CdpSink): void {
		this.sink = sink
	}
	clearSink(sink: CdpSink): void {
		if (this.sink === sink) this.sink = null
	}
	isActive(sink: CdpSink): boolean {
		return this.sink === sink
	}
	send(msg: CDPMessage): void {
		this.sink?.(msg)
	}

	/** Stable, bound emitter handed to every domain. */
	readonly emit: EmitEvent = (method: string, params: unknown): void => {
		this.send({ method, params: isRecord(params) ? params : {} })
	}
}

export interface ConnectionDeps {
	channel: CdpChannel
	dispatcher: CDPDispatcher
	rpc: WorkerEndpoint
	entryUrl: string
	debuggerDomain: DebuggerDomain
	runtimeDomain: RuntimeDomain
}

export function handleDevToolsConnection(ws: WebSocket, deps: ConnectionDeps): void {
	const { channel, dispatcher, rpc, debuggerDomain, runtimeDomain } = deps

	const thisSend: CdpSink = (msg) => ws.send(JSON.stringify(msg))
	channel.setSink(thisSend)

	debuggerDomain.setConnected(true)
	runtimeDomain.setConnected(true)
	void rpc.call('setConnected', { connected: true })

	ws.onmessage = (ev): void => {
		if (!channel.isActive(thisSend)) return
		const raw = typeof ev.data === 'string' ? ev.data : engine.decodeString(ev.data)
		let message: CDPMessage | null
		try {
			message = parseCDPMessage(raw)
		} catch {
			thisSend({ id: null, error: { code: CdpErrorCode.ParseError, message: 'Invalid JSON' } })
			return
		}
		if (!message) {
			thisSend({ id: null, error: { code: CdpErrorCode.InvalidRequest, message: 'CDP message must be a JSON object' } })
			return
		}
		const { id, method, params, sessionId } = message
		if (id == null) return
		if (!method) {
			thisSend({ id, error: { code: CdpErrorCode.InvalidRequest, message: 'CDP command method is required' }, sessionId })
			return
		}
		let normalizedParams: CdpParams
		try {
			normalizedParams = normalizeParams(params)
		} catch (error) {
			thisSend({ id, error: formatCdpError(error), sessionId })
			return
		}
			void dispatcher
				.dispatch(method, normalizedParams)
				.then((result) => {
					thisSend({ id, result: result ?? {}, sessionId })
				})
			.catch((err: unknown) => {
				thisSend({ id, error: formatCdpError(err), sessionId })
			})
	}

	ws.onclose = (): void => {
		// Ignore a close from a socket that has already been superseded.
		if (!channel.isActive(thisSend)) return
		channel.clearSink(thisSend)
		debuggerDomain.setConnected(false)
		runtimeDomain.setConnected(false)
		void rpc.call('setConnected', { connected: false })
	}
}

function normalizeParams(params: unknown): CdpParams {
	if (params == null) return {}
	if (!isRecord(params)) {
		throw new CDPError(CdpErrorCode.InvalidParams, 'CDP params must be an object')
	}
	return params
}
