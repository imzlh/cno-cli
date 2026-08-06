/**
 * domains/runtime.ts — Runtime CDP domain (worker thread).
 *
 * Drives console-tab evaluation, the (single) execution context, and host
 * bindings. All real evaluation is delegated to the main thread over the
 * inspect transport; this domain only enforces the side-effect gate locally so
 * DevTools' as-you-type previews never mutate program state.
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
 * Console messages held until `Runtime.enable`. Same reason ConsoleDomain keeps a
 * backlog, and the same bound: an unbounded buffer in a process that logs in a loop
 * is a memory leak with no upper limit.
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
			// Replay console output produced before the frontend enabled the domain.
			// MEASURED, node v24.18: attach, wait 1.5s while the target logs every
			// 300ms, THEN Runtime.enable -> 11 consoleAPICalled arrive at once,
			// carrying "tick 1".."tick 11", i.e. every message from before the enable.
			// Without this a reattaching DevTools showed an empty console, because
			// modern DevTools reads Runtime.consoleAPICalled and treats the Console
			// domain as deprecated — so ConsoleDomain's backlog alone never surfaced.
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
			// `expression` is required by the CDP contract (it is non-optional in
			// RuntimeCompileScriptParams). MEASURED, node v24.18, params {}:
			//   -32602 "Invalid parameters" (data names the field).
			// MEASURED, cno before this check: a REAL, usable scriptId — it compiled
			// `export default (undefined)` and stored it in the compiled-script table,
			// so the reply was indistinguishable from a successful compile.
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
	 * Console output from the main thread, forwarded as Runtime.consoleAPICalled.
	 *
	 * Gated on Runtime.enable and buffered until then, both MEASURED against node
	 * v24.18: with a target logging every 300ms, a session that attached and never
	 * called Runtime.enable received 0 consoleAPICalled over 1.5s, and one that
	 * enabled after 1.5s received all 11 missed messages at once. This used to emit
	 * unconditionally from event-router.ts, so cno both sent events DevTools had not
	 * subscribed to and lost anything logged before the enable.
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
			// Back to buffering, like ConsoleDomain: `enabled` is per-session state in
			// V8, so a reattaching frontend's Runtime.enable must replay what it missed
			// while nobody was attached. Leaving it set would emit into a dead sink and
			// drop the messages permanently.
			this.enabled = false
			this.rpc.notify('releaseObjectGroup', { objectGroup: 'console' })
			this.rpc.notify('releaseObjectGroup', { objectGroup: 'runtime' })
		}
	}
}
