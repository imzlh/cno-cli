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

import type { CDPMessage } from '../shared/cdp'
import type { EmitEvent, CDPDispatcher } from './dispatcher'
import type { WorkerEndpoint } from '../transport/worker-endpoint'
import type { DebuggerDomain } from '../domains/debugger'
import type { RuntimeDomain } from '../domains/runtime'
import type { PageDomain } from '../domains/page'

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
		this.send({ method, params: params as Record<string, unknown> })
	}
}

export interface ConnectionDeps {
	channel: CdpChannel
	dispatcher: CDPDispatcher
	rpc: WorkerEndpoint
	entryUrl: string
	debuggerDomain: DebuggerDomain
	runtimeDomain: RuntimeDomain
	pageDomain: PageDomain
}

export function handleDevToolsConnection(ws: WebSocket, deps: ConnectionDeps): void {
	const { channel, dispatcher, rpc, entryUrl, debuggerDomain, runtimeDomain, pageDomain } = deps

	const thisSend: CdpSink = (msg) => ws.send(JSON.stringify(msg))
	channel.setSink(thisSend)

	debuggerDomain.setConnected(true)
	runtimeDomain.setConnected(true)
	pageDomain.onConnected(entryUrl)
	void rpc.call('setConnected', { connected: true })

	ws.onmessage = (ev): void => {
		const raw = typeof ev.data === 'string' ? ev.data : engine.decodeString(ev.data)
		let message: CDPMessage
		try {
			message = JSON.parse(raw) as CDPMessage
		} catch {
			return
		}
		const { id, method, params, sessionId } = message
		if (id == null || !method) return
		void dispatcher
			.dispatch(method, (params ?? {}) as Record<string, unknown>)
			.then((result) => {
				thisSend({ id, result: (result ?? {}) as Record<string, unknown>, sessionId })
			})
			.catch((err: unknown) => {
				const messageText = err instanceof Error ? err.message : String(err)
				thisSend({ id, error: { code: -32000, message: messageText }, sessionId })
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
