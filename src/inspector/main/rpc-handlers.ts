/**
 * main/rpc-handlers.ts - registers every RPC method the worker may call on the
 * main thread.
 *
 * These are the `inspect`- and `lifecycle`-transport methods (evaluate,
 * getProperties, ready, setConnected). `control`-transport methods
 * (breakpoints, requestPause) are applied directly on the debug channel by the
 * worker endpoint and never reach here.
 *
 * Every handler returns a concrete CDP shape; the endpoint forwards it verbatim.
 */

import { native } from '../shared/native'
import type { RpcParams } from '../shared/rpc-contract'
import type { MainEndpoint } from '../transport/main-endpoint'
import type { Serializer } from './remote-object'
import type { Evaluator } from './evaluator'
import type { Hooks } from './hooks'
import type { PauseController } from './pause-controller'

const engine = import.meta.use('engine')
const fs = import.meta.use('fs')
const os = import.meta.use('os')

const EVAL_FRAME_OFFSET = 8

export interface RpcHandlerDeps {
	serializer: Serializer
	evaluator: Evaluator
	hooks: Hooks
	pauseController: PauseController
	onReady: (params: RpcParams['ready']) => void
	onConnectedChange: (connected: boolean) => void
	onRuntimeReady: () => void
	onWorkerError: (params: RpcParams['workerError']) => void
}

export function registerRpcHandlers(endpoint: MainEndpoint, deps: RpcHandlerDeps): void {
	const { serializer, evaluator, hooks } = deps

	endpoint.registerMany({
		ready: (q) => {
			deps.onReady(q)
			return {}
		},
		setConnected: (q) => {
			deps.onConnectedChange(q.connected)
			return {}
		},
		runtimeReady: () => {
			deps.onRuntimeReady()
			return {}
		},
		workerError: (q) => {
			deps.onWorkerError(q)
			return {}
		},

		getScriptSource: (q) => {
			try {
				return { scriptSource: engine.decodeString(fs.readFile(hooks.scriptSourcePath(q.scriptId))) }
			} catch {
				return { scriptSource: '' }
			}
		},
		getResourceContent: (q) => {
			try {
				return { content: engine.decodeString(fs.readFile(hooks.scriptSourcePath(q.url))), base64Encoded: false }
			} catch {
				return { content: '', base64Encoded: false }
			}
		},

		evaluate: (q) => q.paused ? evaluator.evaluateSync(q) : evaluator.evaluate(q),
		callFunctionOn: (q) => q.paused ? evaluator.callFunctionOnSync(q) : evaluator.callFunctionOn(q),
		awaitPromise: (q) => q.paused ? evaluator.awaitPromiseSync(q) : evaluator.awaitPromise(q),
		compileScript: (q) => evaluator.compileScript(q),
		runScript: (q) => q.paused ? evaluator.runScriptSync(q) : evaluator.runScript(q),
		globalLexicalScopeNames: () => ({ names: Object.keys(engine.getGlobalLexVar()) }),

		getProperties: (q) => {
			const group = q.objectGroup ?? serializer.groupOf(q.objectId) ?? 'runtime'
			let { result } = serializer.getProperties(q.objectId, group)
			if (q.accessorPropertiesOnly) {
				result = result.filter(p => p.get != null || p.set != null)
			}
			const internalProperties: { name: string; value: unknown }[] = []
			try {
				const obj = serializer.resolve(q.objectId)
				if (obj != null && typeof obj === 'object') {
					const proto = Object.getPrototypeOf(obj)
					if (proto != null) {
						internalProperties.push({
							name: '[[Prototype]]',
							value: serializer.serialize(proto, group, { preview: true }),
						})
					}
				}
			} catch {}
			return { result, internalProperties }
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
			const scope = deps.pauseController.normalizeScope(String(q.callFrameId ?? '0'), q.scopeNumber ?? 0)
			native.setVariable(EVAL_FRAME_OFFSET + level, q.variableName, evaluator.resolveArgument(q.newValue), scope)
			return {}
		},

		getHeapUsage: () => {
			const m = os.memoryUsage() as unknown as Record<string, number>
			return {
				usedSize: m['used'] ?? m['vm.used'] ?? 0,
				totalSize: m['limit'] ?? m['os.total'] ?? 0,
			}
		},

		addBinding: (q) => {
			hooks.installBinding(q.name)
			return {}
		},
		removeBinding: (q) => {
			hooks.removeBinding(q.name)
			return {}
		},

		fetchInterceptResult: (q) => {
			hooks.resolveIntercept(q.requestId, q.result)
			return {}
		},
		streamResourceContent: (q) => {
			hooks.enableStreamingForRequest(q.requestId)
			return {}
		},
	})
}
