/**
 * inspector/shared/rpc-contract.ts — the single source of truth for worker↔main
 * RPC: the method set, each method's parameter shape, and which transport each
 * method travels over.
 *
 * Because identity (`RpcMethod`) and transport (`RPC_TRANSPORT`) live together,
 * a method can never be sent over the wrong wire — the historical bug where
 * control ops silently fell through to the async pipe is structurally
 * impossible now.
 *
 * Transport classes:
 *   • inspect   — needs the main JS thread; channel while PAUSED, pipe while RUNNING.
 *   • lifecycle — worker→main handshake (ready / setConnected); always the pipe.
 *   • control   — breakpoints / stepping / pause; applied in C at a safepoint, so
 *                always the DebugChannel regardless of run state.
 *
 * Param shapes use precise field types; dynamic JS values are `unknown` and
 * structured CDP arguments use `RpcCallArgument` — no `any`.
 */

import type { RpcCallArgument } from './cdp'
import type { InterceptResult } from '../../../cno/src/utils/network-hooks'

// ── parameter shapes (one entry per method) ────────────────────────────────
export interface RpcParams {
	// lifecycle (pipe)
	ready: { wsUrl?: string }
	setConnected: { connected: boolean }
	workerError: { message: string; stack?: string; phase?: string }

	// inspect (pipe while running, channel while paused)
	getScriptSource: { scriptId: string }
	evaluate: {
		expression: string
		callFrameId?: string | number
		objectGroup?: string
		generatePreview?: boolean
		returnByValue?: boolean
		throwOnSideEffect?: boolean
		awaitPromise?: boolean
		paused?: boolean
	}
	getProperties: {
		objectId: string
		ownProperties?: boolean
		accessorPropertiesOnly?: boolean
		generatePreview?: boolean
		objectGroup?: string
	}
	callFunctionOn: {
		objectId?: string
		functionDeclaration: string
		arguments?: RpcCallArgument[]
		returnByValue?: boolean
		generatePreview?: boolean
		objectGroup?: string
		throwOnSideEffect?: boolean
		paused?: boolean
	}
	awaitPromise: {
		promiseObjectId: string
		returnByValue?: boolean
		generatePreview?: boolean
		objectGroup?: string
		paused?: boolean
	}
	setVariableValue: {
		scopeNumber: number
		variableName: string
		newValue: RpcCallArgument
		callFrameId?: string | number
	}
	compileScript: { expression: string; sourceURL?: string; persistScript?: boolean }
	runScript: { scriptId: string; objectGroup?: string; returnByValue?: boolean; generatePreview?: boolean; paused?: boolean }
	releaseObject: { objectId: string }
	releaseObjectGroup: { objectGroup?: string; groupName?: string }
	globalLexicalScopeNames: Record<string, never>
	getHeapUsage: Record<string, never>
	addBinding: { name: string }
	removeBinding: { name: string }
	fetchInterceptResult: { requestId: string; result: InterceptResult | null }

	// control (channel; valid running or paused)
	addBreakpoint: { url: string; line: number; col?: number }
	removeBreakpoint: { url: string; line: number }
	clearBreakpoints: Record<string, never>
	setBreakpointsActive: { active: boolean }
	setExceptionBreakpoint: { enabled: boolean }
	requestPause: Record<string, never>
}

/** Every RPC method name, derived from the param table so the two never drift. */
export type RpcMethod = keyof RpcParams

// ── transport routing ────────────────────────────────────────────
export type RpcTransport = 'inspect' | 'lifecycle' | 'control'

export const RPC_TRANSPORT: Record<RpcMethod, RpcTransport> = {
	ready: 'lifecycle',
	setConnected: 'lifecycle',
	workerError: 'lifecycle',

	getScriptSource: 'inspect',
	evaluate: 'inspect',
	getProperties: 'inspect',
	callFunctionOn: 'inspect',
	awaitPromise: 'inspect',
	setVariableValue: 'inspect',
	compileScript: 'inspect',
	runScript: 'inspect',
	releaseObject: 'inspect',
	releaseObjectGroup: 'inspect',
	globalLexicalScopeNames: 'inspect',
	getHeapUsage: 'inspect',
	addBinding: 'inspect',
	removeBinding: 'inspect',
	fetchInterceptResult: 'inspect',

	addBreakpoint: 'control',
	removeBreakpoint: 'control',
	clearBreakpoints: 'control',
	setBreakpointsActive: 'control',
	setExceptionBreakpoint: 'control',
	requestPause: 'control',
}

/** Transport class for a method. */
export function transportOf(method: RpcMethod): RpcTransport {
	return RPC_TRANSPORT[method]
}

/** True for control-class methods (breakpoints / stepping / pause). */
export function isControlMethod(method: RpcMethod): boolean {
	return RPC_TRANSPORT[method] === 'control'
}

/**
 * Result of an RPC method. Results are arbitrary CDP JSON, so the contract is
 * `unknown` — every endpoint produces a concrete CDP shape (EvaluateResponse,
 * GetPropertiesResponse, …) and every caller forwards it verbatim to DevTools.
 */
export type RpcResult = unknown

/** A main-thread handler for one RPC method, typed by its parameter shape. */
export type RpcHandler<M extends RpcMethod> = (params: RpcParams[M]) => RpcResult | Promise<RpcResult>
