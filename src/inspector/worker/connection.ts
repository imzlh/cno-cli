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
import type { ConsoleDomain } from '../domains/console'
import type { DebuggerDomain } from '../domains/debugger'
import type { FetchDomain } from '../domains/fetch'
import type { NetworkDomain } from '../domains/network'
import type { RuntimeDomain } from '../domains/runtime'

const engine = import.meta.use('engine');

type CdpSink = (msg: CDPMessage) => void

/** Routes domain events to the currently-attached DevTools socket, if any. */
export class CdpChannel {
	private sink: CdpSink | null = null
	private socket: WebSocket | null = null

	setSink(sink: CdpSink): void {
		this.sink = sink
	}
	/** Install `ws` as the owner and return the socket it displaced, if any. */
	takeSocket(ws: WebSocket): WebSocket | null {
		const previous = this.socket === ws ? null : this.socket
		this.socket = ws
		return previous
	}
	clearSocket(ws: WebSocket): void {
		if (this.socket === ws) this.socket = null
	}
	clearSink(sink: CdpSink): void {
		if (this.sink === sink) this.sink = null
	}
	/**
	 * Unconditionally detach the current sink. Used when an incoming connection
	 * displaces an existing one: the caller does not hold the old sink reference,
	 * and the teardown that follows must not emit into the incoming socket.
	 */
	dropSink(): void {
		this.sink = null
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
	consoleDomain: ConsoleDomain
	networkDomain: NetworkDomain
	fetchDomain: FetchDomain
}

export function handleDevToolsConnection(ws: WebSocket, deps: ConnectionDeps): void {
	const { channel, dispatcher, rpc, debuggerDomain, runtimeDomain, consoleDomain, networkDomain, fetchDomain } = deps

	/**
	 * Return every domain to its detached state. Domain `enabled` flags, paused
	 * Fetch requests and the paused safepoint are all per-SESSION state in CDP, so
	 * they must not survive the client that created them.
	 */
	const releaseSession = (): void => {
		debuggerDomain.setConnected(false)
		runtimeDomain.setConnected(false)
		consoleDomain.setConnected(false)
		networkDomain.setConnected(false)
		fetchDomain.setConnected(false)
		rpc.notify('setConnected', { connected: false })
	}

	const thisSend: CdpSink = (msg) => ws.send(JSON.stringify(msg))
	// Only one client can own the domains; drop the previous socket instead of
	// leaving it half-attached (its commands would be silently ignored forever).
	const superseded = channel.takeSocket(ws)
	if (superseded) {
		// The displaced socket's own onclose cannot do this: it early-returns on
		// `!channel.isActive(...)`, which is already false by the time a close
		// handshake completes — and a client that vanished may never send one at all.
		// Without this the previous session's paused Fetch requests were held forever
		// and its Fetch.enable leaked into the new session.
		//
		// Ordered deliberately: drop the sink FIRST so the teardown's own events
		// (Debugger.resumed) are not delivered to the incoming client as if they
		// belonged to it.
		channel.dropSink()
		releaseSession()
		try { superseded.close() } catch { /* already gone */ }
	}
	channel.setSink(thisSend)

	debuggerDomain.setConnected(true)
	runtimeDomain.setConnected(true)
	rpc.notify('setConnected', { connected: true })

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
		// Never drop a command silently: a client that sent a malformed id would
		// otherwise wait forever with no indication anything was wrong. Real node
		// answers every shape — MEASURED on v24.18: `{"method":"Runtime.enable"}`
		// with no id returns
		// {"error":{"code":-32600,"message":"Message must have integer 'id' property"}}.
		// `parseCDPMessage` only keeps a number-or-null id, so a string or float id
		// arrives here as absent and lands in this branch too; node rejects those as
		// well. Messages carrying `result`/`error` are replies rather than commands
		// and legitimately have no id for us, so they stay ignored.
		if (id == null) {
			if ('result' in message || 'error' in message) return
			thisSend({ id: null, error: { code: CdpErrorCode.InvalidRequest, message: "Message must have integer 'id' property" } })
			return
		}
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

	const detach = (): void => {
		// Ignore a close from a socket that has already been superseded; the
		// incoming connection released the session on its behalf.
		if (!channel.isActive(thisSend)) return
		channel.clearSink(thisSend)
		channel.clearSocket(ws)
		releaseSession()
	}

	ws.onclose = detach
	// A transport error may never produce a clean close; treat it as a detach so
	// paused execution and intercepted requests are never stranded.
	ws.onerror = detach
}

function normalizeParams(params: unknown): CdpParams {
	if (params == null) return {}
	if (!isRecord(params)) {
		throw new CDPError(CdpErrorCode.InvalidParams, 'CDP params must be an object')
	}
	return params
}
