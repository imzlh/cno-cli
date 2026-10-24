/**
 * worker/event-router.ts — maps the worker-side `(WorkerEvent, params)` stream
 * onto CDP domains, keeping bootstrap.ts free of switch logic.
 */

import type { ConsoleDomain } from '../domains/console'
import type { DebuggerDomain } from '../domains/debugger'
import type { FetchDomain } from '../domains/fetch'
import type { NetworkDomain } from '../domains/network'
import type { RuntimeDomain } from '../domains/runtime'
import type { PausedEvent } from '../shared/cdp'
import type {
	BindingCalledPayload,
	ConsolePayload,
	FetchInterceptPayload,
	NetFetchEvent,
	NetServeEvent,
	NetWSEvent,
	ScriptParsedPayload,
} from '../shared/wire'
import { WorkerEvent } from '../shared/wire'
import type { WorkerEndpoint } from '../transport/worker-endpoint'
import type { EmitEvent } from './dispatcher'

export interface EventRouterDeps {
	endpoint: WorkerEndpoint
	/** For domains needing a direct emitter; Runtime.consoleAPICalled is gated, so not one. */
	emit: EmitEvent
	debuggerDomain: DebuggerDomain
	runtimeDomain: RuntimeDomain
	consoleDomain: ConsoleDomain
	networkDomain: NetworkDomain
	fetchDomain: FetchDomain
}

export function createEventRouter(deps: EventRouterDeps): (event: WorkerEvent, params: unknown) => void {
	const { endpoint, debuggerDomain, runtimeDomain, consoleDomain, networkDomain, fetchDomain } = deps

	return (event: WorkerEvent, params: unknown): void => {
		switch (event) {
			case WorkerEvent.Paused: {
				endpoint.setPaused(true)
				debuggerDomain.onPaused(params as PausedEvent)
				break
			}
			case WorkerEvent.Resumed: {
				// Resume is driven by DevTools via Debugger.resume; nothing to route.
				break
			}
			case WorkerEvent.ScriptParsed: {
				const payload = params as ScriptParsedPayload
				debuggerDomain.onScriptParsed(payload)
				break
			}
			case WorkerEvent.Console: {
				const payload = params as ConsolePayload
				consoleDomain.onConsole(payload.method, payload.args, payload.timestamp, payload.callFrames)
				// Runtime owns its own half of console forwarding: it must be gated on
				// Runtime.enable and buffered until then. See RuntimeDomain.onConsole.
				runtimeDomain.onConsole(payload)
				break
			}
			case WorkerEvent.Load: {
				break
			}
			case WorkerEvent.BindingCalled: {
				const payload = params as BindingCalledPayload
				runtimeDomain.onBindingCalled(payload.name, payload.payload)
				break
			}
			case WorkerEvent.NetFetch: {
				networkDomain.onFetchEvent(params as NetFetchEvent)
				break
			}
			case WorkerEvent.NetWs: {
				networkDomain.onWSEvent(params as NetWSEvent)
				break
			}
			case WorkerEvent.NetServe: {
				networkDomain.onServeEvent(params as NetServeEvent)
				break
			}
			case WorkerEvent.FetchIntercept: {
				fetchDomain.onInterceptRequest(params as FetchInterceptPayload)
				break
			}
		}
	}
}
