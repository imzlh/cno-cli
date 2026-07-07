/**
 * worker/event-router.ts — turns raw worker-side debug events into domain calls.
 *
 * The WorkerEndpoint hands us a `(WorkerEvent, params)` stream from the C debug
 * channel and native hooks. This router is the single place that knows how each
 * event maps onto the CDP domains, keeping `bootstrap.ts` free of switch logic.
 * `params` arrives as `unknown` and is narrowed to the wire payload for each
 * event tag before use — no `any`.
 */

import type { ConsoleDomain } from '../domains/console'
import type { DebuggerDomain } from '../domains/debugger'
import type { FetchDomain } from '../domains/fetch'
import type { NetworkDomain } from '../domains/network'
import type { PageDomain } from '../domains/page'
import type { RuntimeDomain } from '../domains/runtime'
import type { PausedEvent } from '../shared/cdp'
import { buildConsoleStackTrace, consoleAPICalledType } from '../shared/console-utils'
import type {
	BindingCalledPayload,
	ConsolePayload,
	FetchInterceptPayload,
	LoadPayload,
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
	emit: EmitEvent
	debuggerDomain: DebuggerDomain
	runtimeDomain: RuntimeDomain
	consoleDomain: ConsoleDomain
	pageDomain: PageDomain
	networkDomain: NetworkDomain
	fetchDomain: FetchDomain
}

export function createEventRouter(deps: EventRouterDeps): (event: WorkerEvent, params: unknown) => void {
	const { endpoint, emit, debuggerDomain, runtimeDomain, consoleDomain, pageDomain, networkDomain, fetchDomain } = deps
	let scriptCount = 0

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
				pageDomain.onScriptParsed(payload.url || payload.scriptId)
				if (scriptCount++ === 0) pageDomain.onDOMContent(Date.now() / 1000)
				break
			}
			case WorkerEvent.Console: {
				const payload = params as ConsolePayload
				consoleDomain.onConsole(payload.method, payload.args, payload.timestamp, payload.callFrames)

				emit('Runtime.consoleAPICalled', {
					type: consoleAPICalledType(payload.method),
					args: payload.args,
					executionContextId: 1,
					timestamp: payload.timestamp,
					stackTrace: buildConsoleStackTrace(payload.callFrames),
				})
				break
			}
			case WorkerEvent.Load: {
				const payload = params as LoadPayload
				pageDomain.onLoad(payload.timestamp)
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
