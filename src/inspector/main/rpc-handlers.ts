/**
 * main/rpc-handlers.ts — registers every RPC method the worker may call on the
 * main thread.
 *
 * These are the `inspect`- and `lifecycle`-transport methods (evaluate,
 * getProperties, …, ready, setConnected). `control`-transport methods
 * (breakpoints, requestPause) are applied directly on the debug channel by the
 * worker endpoint and never reach here.
 *
 * Every handler returns a concrete CDP shape; the endpoint forwards it verbatim.
 */

import { native } from '../shared/native'
import { isUserFile } from '../shared/user-files'
import type { RpcParams } from '../shared/rpc-contract'
import type { MainEndpoint } from '../transport/main-endpoint'
import type { Serializer } from './remote-object'
import type { Evaluator } from './evaluator'
import type { Hooks } from './hooks'

const engine = import.meta.use('engine')
const fs = import.meta.use('fs')
const os = import.meta.use('os')

const EVAL_FRAME_OFFSET = 8

export interface RpcHandlerDeps {
	serializer: Serializer
	evaluator: Evaluator
	hooks: Hooks
	/** Called when the worker reports the DevTools WS server is listening. */
	onReady: (params: RpcParams['ready']) => void
	/** Called when a DevTools front-end connects (true) or disconnects (false). */
	onConnectedChange: (connected: boolean) => void
	/** Called when the debug worker reports a fatal startup/runtime error. */
	onWorkerError: (params: RpcParams['workerError']) => void
}

export function registerRpcHandlers(endpoint: MainEndpoint, deps: RpcHandlerDeps): void {
	const { serializer, evaluator, hooks } = deps

	endpoint.registerMany({
		// ── lifecycle ───────────────────────────────────────────────
		ready: (q) => {
			deps.onReady(q)
			return {}
		},
		setConnected: (q) => {
			deps.onConnectedChange(q.connected)
			return {}
		},
		workerError: (q) => {
			deps.onWorkerError(q)
			return {}
		},

		// ── source ──────────────────────────────────────────────────
		getScriptSource: (q) => {
			try {
				return { scriptSource: engine.decodeString(fs.readFile(hooks.scriptSourcePath(q.scriptId))) }
			} catch {
				return { scriptSource: '' }
			}
		},

		// ── evaluation ──────────────────────────────────────────────
		evaluate: (q) => q.paused ? evaluator.evaluateSync(q) : evaluator.evaluate(q),
		callFunctionOn: (q) => q.paused ? evaluator.callFunctionOnSync(q) : evaluator.callFunctionOn(q),
		awaitPromise: (q) => q.paused ? evaluator.awaitPromiseSync(q) : evaluator.awaitPromise(q),
		compileScript: (q) => evaluator.compileScript(q),
		runScript: (q) => q.paused ? evaluator.runScriptSync(q) : evaluator.runScript(q),
		globalLexicalScopeNames: () => ({ names: Object.keys(engine.getGlobalLexVar()) }),

		// ── object inspection ───────────────────────────────────────
		getProperties: (q) => {
			const { result } = serializer.getProperties(q.objectId, q.ownProperties ?? true, q.objectGroup ?? 'runtime')
			return { result, internalProperties: [] }
		},
		releaseObject: (q) => {
			serializer.release(q.objectId)
			return {}
		},
		releaseObjectGroup: (q) => {
			serializer.releaseGroup(q.objectGroup ?? q.groupName ?? 'runtime')
			return {}
		},
		setVariableValue: (q) => {
			const level = Number(q.callFrameId ?? 0) || 0
			native.setVariable(EVAL_FRAME_OFFSET + level, q.variableName, evaluator.resolveArgument(q.newValue))
			return {}
		},

		// ── runtime metrics ─────────────────────────────────────────
		getHeapUsage: () => {
			const m = os.memoryUsage() as unknown as Record<string, number>
			return {
				usedSize: m['used'] ?? m['vm.used'] ?? 0,
				totalSize: m['limit'] ?? m['os.total'] ?? 0,
			}
		},

		// ── bindings ─────────────────────────────────────────────────
		addBinding: (q) => {
			hooks.installBinding(q.name)
			return {}
		},
		removeBinding: (q) => {
			hooks.removeBinding(q.name)
			return {}
		},

		// ── fetch interception ──────────────────────────────────────
		fetchInterceptResult: (q) => {
			hooks.resolveIntercept(q.requestId, q.result)
			return {}
		},
	})
}
