/**
 * domains/runtime.ts — Runtime CDP domain (worker thread).
 *
 * Drives console-tab evaluation, the (single) execution context, and host
 * bindings. All real evaluation is delegated to the main thread over the
 * inspect transport; this domain only enforces the side-effect gate locally so
 * DevTools' as-you-type previews never mutate program state.
 */

import { Domain } from './base'
import type { CDPDispatcher, EmitEvent } from '../worker/dispatcher'
import type { WorkerEndpoint } from '../transport/worker-endpoint'
import type { RpcCallArgument } from '../shared/cdp'
import type {
	RuntimeEvaluateParams,
	RuntimeGetPropertiesParams,
	RuntimeCallFunctionOnParams,
	RuntimeCompileScriptParams,
	RuntimeRunScriptParams,
	RuntimeAwaitPromiseParams,
} from '../shared/cdp'
import { isSideEffectFree } from './side-effect'

function sideEffectException(): Record<string, unknown> {
	const description = 'EvalError: Possible side-effect in debug-evaluate'
	const exception = { type: 'object', subtype: 'error', className: 'EvalError', description }
	return {
		result: exception,
		exceptionDetails: {
			text: 'Uncaught',
			exceptionId: 1,
			lineNumber: -1,
			columnNumber: -1,
			exception,
		},
	}
}

export class RuntimeDomain extends Domain {
	private enabled = false
	private connected = false
	private activeBindings = new Set<string>()

	constructor(
		dispatcher: CDPDispatcher,
		event: EmitEvent,
		private readonly rpc: WorkerEndpoint,
	) {
		super(dispatcher, event)
		this.registerHandlers()
	}

	private registerHandlers(): void {
		this.on('Runtime.enable', () => {
			this.enabled = true
			this.event('Runtime.executionContextCreated', {
				context: { id: 1, origin: '', name: 'cno', uniqueId: '1', auxData: { isDefault: true } },
			})
			return {}
		})
		this.on('Runtime.disable', () => {
			this.enabled = false
			return this.rpc.call('releaseObjectGroup', { objectGroup: 'runtime' })
		})
		this.on('Runtime.runIfWaitingForDebugger', () => ({}))
		this.on('Runtime.discardConsoleEntries', () => ({}))

		this.on('Runtime.evaluate', (p) => {
			const q = this.extract<RuntimeEvaluateParams>(p)
			if (q.throwOnSideEffect && !isSideEffectFree(q.expression)) return sideEffectException()
			const isPaused = this.rpc.isPaused()
			return this.rpc.call('evaluate', {
				expression: q.expression,
				objectGroup: q.objectGroup,
				generatePreview: q.generatePreview,
				returnByValue: q.returnByValue,
				awaitPromise: q.awaitPromise,
				paused: isPaused,
				callFrameId: 0,
			})
		})

		this.on('Runtime.getProperties', (p) => {
			const q = this.extract<RuntimeGetPropertiesParams>(p)
			return this.rpc.call('getProperties', {
				objectId: q.objectId,
				ownProperties: q.ownProperties,
				accessorPropertiesOnly: q.accessorPropertiesOnly,
				generatePreview: q.generatePreview,
			})
		})

		this.on('Runtime.releaseObject', (p) => this.rpc.call('releaseObject', { objectId: this.reqStr(p, 'objectId') }))
		this.on('Runtime.releaseObjectGroup', (p) => {
			const group = this.str(p, 'objectGroup') || this.str(p, 'objectGroupName') || 'runtime'
			return this.rpc.call('releaseObjectGroup', { objectGroup: group })
		})

		this.on('Runtime.callFunctionOn', (p) => {
			const q = this.extract<RuntimeCallFunctionOnParams>(p)
			if (q.throwOnSideEffect && !isSideEffectFree(q.functionDeclaration)) return sideEffectException()
			const isPaused = this.rpc.isPaused()
			return this.rpc.call('callFunctionOn', {
				objectId: q.objectId,
				functionDeclaration: q.functionDeclaration,
				arguments: q.arguments,
				returnByValue: q.returnByValue,
				generatePreview: q.generatePreview,
				objectGroup: q.objectGroup,
				paused: isPaused,
			})
		})

		this.on('Runtime.compileScript', (p) => {
			const q = this.extract<RuntimeCompileScriptParams>(p)
			return this.rpc.call('compileScript', {
				expression: q.expression,
				sourceURL: q.sourceURL,
				persistScript: q.persistScript,
			})
		})
		this.on('Runtime.runScript', (p) => {
			const q = this.extract<RuntimeRunScriptParams>(p)
			return this.rpc.call('runScript', {
				scriptId: q.scriptId,
				objectGroup: q.objectGroup,
				returnByValue: q.returnByValue,
				generatePreview: q.generatePreview,
				paused: this.rpc.isPaused(),
			})
		})

		this.on('Runtime.globalLexicalScopeNames', () => this.rpc.call('globalLexicalScopeNames', {}))
		this.on('Runtime.getHeapUsage', () => this.rpc.call('getHeapUsage', {}))
		this.on('Runtime.getIsolateId', () => ({ id: 'cno-isolate-1' }))

		// Stubs.
		this.on('Runtime.awaitPromise', (p) => {
			const q = this.extract<RuntimeAwaitPromiseParams>(p)
			const promiseObjectId = q.promiseObjectId ?? q.objectId
			if (promiseObjectId) return this.rpc.call('awaitPromise', {
				promiseObjectId,
				objectGroup: 'runtime',
				returnByValue: q.returnByValue,
				generatePreview: q.generatePreview,
				paused: this.rpc.isPaused(),
			})
			return { result: { type: 'undefined' } }
		})
		// TODO: needs native heap traversal (JS_GetObjFromProto + GC mark walk).
		this.on('Runtime.queryObjects', () => ({ objects: { type: 'object', subtype: 'array', description: 'Array(0)', objectId: undefined } }))
		this.on('Runtime.terminateExecution', () => ({}))
		this.on('Runtime.setMaxCallStackSizeToCapture', () => ({}))
		this.on('Runtime.setCustomObjectFormatterEnabled', () => ({}))

		this.on('Runtime.addBinding', (p) => {
			const name = this.reqStr(p, 'name')
			this.activeBindings.add(name)
			return this.rpc.call('addBinding', { name })
		})
		this.on('Runtime.removeBinding', (p) => {
			const name = this.reqStr(p, 'name')
			this.activeBindings.delete(name)
			return this.rpc.call('removeBinding', { name })
		})
	}

	onBindingCalled(name: string, payload: string): void {
		if (!this.activeBindings.has(name)) return
		this.event('Runtime.bindingCalled', { name, payload, executionContextId: 1 })
	}

	setConnected(connected: boolean): void {
		this.connected = connected
		if (!connected) void this.rpc.call('releaseObjectGroup', { objectGroup: 'runtime' })
	}
}
