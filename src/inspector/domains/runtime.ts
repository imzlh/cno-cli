/**
 * Runtime CDP domain (worker): console-tab evaluation, the single execution
 * context, and host bindings. Evaluation is delegated to the main thread over
 * the inspect transport; this domain only enforces the side-effect gate locally.
 */

import type {
	RuntimeAwaitPromiseParams,
	RuntimeCallFunctionOnParams,
	RuntimeCompileScriptParams,
	RuntimeEvaluateParams,
	RuntimeGetPropertiesParams,
	RuntimeQueryObjectsParams,
	RuntimeRunScriptParams,
} from '../shared/cdp'
import type { WorkerEndpoint } from '../transport/worker-endpoint'
import type { CDPDispatcher, EmitEvent } from '../worker/dispatcher'
import { Domain } from './base'
import { isSideEffectFree, sideEffectException } from './side-effect'
import { buildConsoleStackTrace, consoleAPICalledType } from '../shared/console-utils'
import { getMemoryTier } from '../../../cno/src/utils/memory-tier'
import type { ConsolePayload } from '../shared/wire'

/**
 * Console messages held until `Runtime.enable`, bounded like ConsoleDomain's:
 * an unbounded buffer in a process that logs in a loop is a memory leak.
 */
const MAX_CONSOLE_BACKLOG = { low: 100, normal: 300, high: 500 }[getMemoryTier()] ?? 300

export class RuntimeDomain extends Domain {
	private enabled = false
	private connected = false
	private activeBindings = new Set<string>()
	private consoleBacklog: ConsolePayload[] = []

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
			// Replay console output produced before the frontend enabled the domain:
			// modern DevTools reads Runtime.consoleAPICalled and treats the Console
			// domain as deprecated, so its backlog alone never surfaced.
			const backlog = this.consoleBacklog
			this.consoleBacklog = []
			for (const payload of backlog) this.emitConsoleAPICalled(payload)
			return {}
		})
		this.on('Runtime.disable', () => {
			this.enabled = false
			this.rpc.notify('releaseObjectGroup', { objectGroup: 'console' })
			return this.rpc.call('releaseObjectGroup', { objectGroup: 'runtime' })
		})
		this.on('Runtime.runIfWaitingForDebugger', () => this.rpc.call('runtimeReady', {}))
		// CDP: discards collected console entries. Console arguments are interned
		// into the 'console' object group, which nothing else ever releases.
		this.on('Runtime.discardConsoleEntries', () =>
			this.rpc.call('releaseObjectGroup', { objectGroup: 'console' }))

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
			// `expression` is required by the CDP contract; without the check a
			// missing one compiled `export default (undefined)` and answered with a
			// usable-looking scriptId.
			this.reqStr(p, 'expression')
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
				awaitPromise: q.awaitPromise,
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
				objectGroup: q.objectGroup,
				returnByValue: q.returnByValue,
				generatePreview: q.generatePreview,
				paused: this.rpc.isPaused(),
			})
			return { result: { type: 'undefined' } }
		})
		this.on('Runtime.queryObjects', (p) => {
			const q = this.extract<RuntimeQueryObjectsParams>(p)
			return this.rpc.call('queryObjects', {
				prototypeObjectId: q.prototypeObjectId,
				objectGroup: q.objectGroup,
			})
		})
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

	/**
	 * Forward main-thread console output as Runtime.consoleAPICalled, gated on
	 * Runtime.enable and buffered until then, so a reattaching frontend still
	 * sees what it missed.
	 */
	onConsole(payload: ConsolePayload): void {
		if (this.enabled) {
			this.emitConsoleAPICalled(payload)
			return
		}
		if (this.consoleBacklog.length >= MAX_CONSOLE_BACKLOG) this.consoleBacklog.shift()
		this.consoleBacklog.push(payload)
	}

	private emitConsoleAPICalled(payload: ConsolePayload): void {
		this.event('Runtime.consoleAPICalled', {
			type: consoleAPICalledType(payload.method),
			args: payload.args,
			executionContextId: 1,
			timestamp: payload.timestamp,
			stackTrace: buildConsoleStackTrace(payload.callFrames),
		})
	}

	setConnected(connected: boolean): void {
		this.connected = connected
		if (!connected) {
			// `enabled` is per-session state in V8: leaving it set would emit into a
			// dead sink and drop everything a reattaching frontend missed.
			this.enabled = false
			this.rpc.notify('releaseObjectGroup', { objectGroup: 'console' })
			this.rpc.notify('releaseObjectGroup', { objectGroup: 'runtime' })
		}
	}
}
