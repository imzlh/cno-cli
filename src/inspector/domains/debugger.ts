/**
 * domains/debugger.ts — Debugger CDP domain (worker thread).
 *
 * Owns breakpoint bookkeeping and the pause/resume state machine. Breakpoints
 * and stepping are control-class RPCs (applied in C at a safepoint via the
 * DebugChannel), while source/eval queries go over the inspect transport.
 */

import { log, toPosixPath } from '../../../cts/src/api'
import type {
	CallFrame,
	DebuggerEvaluateOnCallFrameParams,
	DebuggerSetBreakpointParams,
	DebuggerSetVariableValueParams,
	PausedEvent,
	SetBreakpointByUrlParams,
} from '../shared/cdp'
import { isRecord } from '../shared/cdp'
import { Step, type StepCode } from '../shared/native'
import type { PauseOnExceptionsState } from '../shared/rpc-contract'
import type { ScriptParsedPayload } from '../shared/wire'
import type { WorkerEndpoint } from '../transport/worker-endpoint'
import { CDPError, CdpErrorCode, type CDPDispatcher, type EmitEvent } from '../worker/dispatcher'
import { Domain } from './base'

const timers = import.meta.use('timers')
const INITIAL_PAUSE_SETTLE_MS = 50

interface KnownScript {
	scriptId: string
	url: string
	length?: number
	endLine?: number
	normalizedUrl: string
	normalizedScriptId: string
}

interface CdpBreakpoint {
	url: string
	matchUrl: string
	line: number
	col?: number
}

export class DebuggerDomain extends Domain {
	private enabled = false
	private connected = false
	private paused = false
	private pauseOnExceptionsState: PauseOnExceptionsState = 'none'
	private breakpointsActive = true
	private nextBpId = 1
	private knownScripts = new Map<string, KnownScript>()
	private cdpBreakpoints = new Map<string, CdpBreakpoint>()
	private pendingScriptEvents: KnownScript[] = []
	private pendingPausedEvent: PausedEvent | null = null
	private pendingPausedTimer: number | null = null
	private lastScriptParsedAt = 0

	constructor(
		dispatcher: CDPDispatcher,
		event: EmitEvent,
		private readonly rpc: WorkerEndpoint,
	) {
		super(dispatcher, event)
		this.registerHandlers()
	}

	private registerHandlers(): void {
		this.on('Debugger.enable', () => {
			this.enabled = true
			// Replay scripts for every enable call so reconnecting frontends see the
			// full source tree again. pendingScriptEvents preserves early-load order
			// before the first enable; afterwards we fall back to knownScripts.
			if (this.pendingScriptEvents.length > 0) {
				for (const script of this.pendingScriptEvents) this.emitScriptParsed(script)
				this.pendingScriptEvents.length = 0
			} else {
				for (const script of this.knownScripts.values()) this.emitScriptParsed(script)
			}
			this.flushPendingPausedSoon()
			return { debuggerId: 'cno-debugger-1' }
		})
		this.on('Debugger.disable', async () => {
			this.enabled = false
			this.clearPendingPaused()
			for (const id of this.cdpBreakpoints.keys()) {
				const bp = this.cdpBreakpoints.get(id)
				if (bp) await this.rpc.call('removeBreakpoint', { url: bp.url, line: bp.line })
			}
			this.cdpBreakpoints.clear()
			if (this.pauseOnExceptionsState !== 'none') {
				this.pauseOnExceptionsState = 'none'
				await this.rpc.call('setExceptionBreakpoint', { state: 'none' })
			}
			await this.rpc.call('releaseObjectGroup', { objectGroup: 'backtrace' })
			return {}
		})

		this.on('Debugger.pause', () => {
			if (!this.paused) this.rpc.signalInterrupt()
			return {}
		})
		this.on('Debugger.resume', () => this.doResume(Step.None))
		this.on('Debugger.stepOver', () => this.doResume(Step.Over))
		this.on('Debugger.stepInto', () => this.doResume(Step.Into))
		this.on('Debugger.stepOut', () => this.doResume(Step.Out))

		this.on('Debugger.setBreakpointsActive', (p) => {
			this.breakpointsActive = this.bool(p, 'active')
			return this.rpc.call('setBreakpointsActive', { active: this.breakpointsActive })
		})

		this.on('Debugger.setBreakpointByUrl', (p) => {
			const q = this.extract<SetBreakpointByUrlParams>(p)
			const rawUrl = q.url ?? this.urlFromRegex(q.urlRegex)
			if (!rawUrl) return { breakpointId: '', locations: [] }
			const lineNumber = q.lineNumber;
			const columnNumber = q.columnNumber;
			const resolved = this.resolveScriptPath(rawUrl)
			const url = resolved.path
			const breakpointId = `bp-${this.nextBpId++}`
			const line = lineNumber + 1
			const col = columnNumber != null && columnNumber > 0 ? columnNumber + 1 : undefined
			this.cdpBreakpoints.set(breakpointId, { url, matchUrl: this.normalizeUrl(url), line, col })
			if (this.breakpointsActive) void this.rpc.call('addBreakpoint', { url, line, col })
			return {
				breakpointId,
				locations: [{ scriptId: resolved.scriptId, lineNumber, columnNumber: columnNumber ?? 0 }],
			}
		})
		this.on('Debugger.setBreakpoint', (p) => {
			const q = this.extract<DebuggerSetBreakpointParams>(p)
			const loc = this.parseLocation(q.location)
			const url = this.normalizeUrl(loc.scriptId)
			const breakpointId = `bp-${this.nextBpId++}`
			const line = loc.lineNumber + 1
			const col = loc.columnNumber != null && loc.columnNumber > 0 ? loc.columnNumber + 1 : undefined
			this.cdpBreakpoints.set(breakpointId, { url, matchUrl: this.normalizeUrl(url), line, col })
			if (this.breakpointsActive) void this.rpc.call('addBreakpoint', { url, line, col })
			return { breakpointId, actualLocation: loc }
		})
		this.on('Debugger.removeBreakpoint', async (p) => {
			const id = this.reqStr(p, 'breakpointId')
			const bp = this.cdpBreakpoints.get(id)
			if (bp) {
				this.cdpBreakpoints.delete(id)
				await this.rpc.call('removeBreakpoint', { url: bp.url, line: bp.line })
			}
			return {}
		})

		this.on('Debugger.setPauseOnExceptions', (p) => {
			const state = this.pauseOnExceptionsStateFrom(this.reqStr(p, 'state'))
			if (this.pauseOnExceptionsState === state) return {}
			this.pauseOnExceptionsState = state
			return this.rpc.call('setExceptionBreakpoint', { state })
		})

		this.on('Debugger.getScriptSource', (p) => this.rpc.call('getScriptSource', { scriptId: this.reqStr(p, 'scriptId') }))

		this.on('Debugger.evaluateOnCallFrame', (p) => {
			if (!this.paused) {
				return { result: { type: 'undefined' }, exceptionDetails: { text: 'Not paused', exceptionId: 0 } }
			}
			const q = this.extract<DebuggerEvaluateOnCallFrameParams>(p)
			return this.rpc.call('evaluate', {
				expression: q.expression,
				callFrameId: q.callFrameId,
				objectGroup: q.objectGroup ?? 'backtrace',
				returnByValue: q.returnByValue,
				generatePreview: q.generatePreview,
				throwOnSideEffect: q.throwOnSideEffect,
				paused: true,
			})
		})

		this.on('Debugger.setVariableValue', (p) => {
			const q = this.extract<DebuggerSetVariableValueParams>(p)
			return this.rpc.call('setVariableValue', {
				scopeNumber: q.scopeNumber,
				variableName: q.variableName,
				newValue: q.newValue,
				callFrameId: q.callFrameId,
			})
		})

		// Stubs — acknowledged so DevTools doesn't error, but unsupported by cno.
		this.on('Debugger.setAsyncCallStackDepth', () => ({}))
		this.on('Debugger.setBlackboxPatterns', () => ({}))
		this.on('Debugger.setBlackboxedRanges', () => ({}))
		this.on('Debugger.setSkipAllPauses', () => ({}))
		this.on('Debugger.setScriptSource', () => ({ status: 'CompileError' }))
		this.on('Debugger.searchInContent', () => ({ result: [] }))
		this.on('Debugger.getStackTrace', () => ({ stackTrace: { callFrames: [] } }))
		this.on('Debugger.restartFrame', () => ({ callFrames: [] }))
		this.on('Debugger.setReturnValue', () => ({}))
		this.on('Debugger.getPossibleBreakpoints', (p) => {
			const start = isRecord(p.start) ? p.start : undefined
			const end = isRecord(p.end) ? p.end : undefined
			const scriptId = typeof start?.scriptId === 'string' ? start.scriptId : undefined
			const startLineNumber = typeof start?.lineNumber === 'number' ? start.lineNumber : undefined
			if (!scriptId || startLineNumber == null) return { locations: [] }
			const script = this.knownScripts.get(scriptId)
			if (!script) return { locations: [] }
			const startLine = Math.max(0, startLineNumber)
			// CDP end is exclusive; if omitted, include all lines through the script end.
			const endLineNumber = typeof end?.lineNumber === 'number' ? end.lineNumber : undefined
			const endExclusive = endLineNumber != null
				? Math.min(endLineNumber, (script.endLine ?? startLine) + 1)
				: (script.endLine ?? startLine) + 1
			const locations: Array<{ scriptId: string; lineNumber: number }> = []
			for (let line = startLine; line < endExclusive && locations.length < 1000; line++) {
				locations.push({ scriptId: script.scriptId, lineNumber: line })
			}
			return { locations }
		})
	}

	private async releaseBacktraceQuietly(): Promise<void> {
		try {
			await this.rpc.call('releaseObjectGroup', { objectGroup: 'backtrace' })
		} catch {
			// Resume must proceed even if the paused object group was already gone.
		}
	}

	private async doResume(step: StepCode): Promise<Record<string, never>> {
		if (!this.paused) return {}
		this.clearPendingPaused()
		try {
			await this.releaseBacktraceQuietly()
		} finally {
			this.paused = false
			this.rpc.setPaused(false)
			this.rpc.beginResume(step)
			if (this.connected) this.event('Debugger.resumed', {})
		}
		return {}
	}

	private urlFromRegex(regex?: string): string {
		if (!regex) return ''
		// DevTools sends an escaped URL regex; recover a best-effort plain URL.
		let url = regex.replace(/\\(.)/g, '$1')
		// Strip anchors: ^ at start, $ at end.
		url = url.replace(/^\^/, '').replace(/\$$/, '')
		// Strip alternation suffixes (|branch1|branch2 → keep first branch).
		url = url.replace(/\|.*$/, '')
		return url
	}

	/**
	 * Normalise any URL or native path to the canonical form used for
	 * breakpoint comparison.  Handles:
	 *   - file:///D:/foo   (Windows file URL)
	 *   - file:///foo      (POSIX file URL)
	 *   - D:\foo, D:/foo   (Windows native path)
	 *   - /foo             (POSIX native path)
	 */
	private normalizeUrl(url: string): string {
		if (url.startsWith('file://')) {
			try {
				const u = new URL(url)
				let p = u.pathname           // /D:/foo on Windows, /foo on POSIX
				if (/^\/[A-Za-z]:/.test(p)) p = p.slice(1)  // strip leading /
				return this.normalizePath(p)
			} catch { /* fall through */ }
		}
		return this.normalizePath(url)
	}

	private normalizePath(path: string): string {
		const normalized = toPosixPath(path)
		const drive = normalized[0]
		if (drive !== undefined && /^[A-Za-z]:/.test(normalized)) return drive.toUpperCase() + normalized.slice(1)
		return normalized
	}

	private resolveScriptPath(rawUrl: string): { path: string; scriptId: string } {
		const normalized = this.normalizeUrl(rawUrl)
		for (const script of this.knownScripts.values()) {
			if (script.normalizedUrl === normalized || script.normalizedScriptId === normalized) {
				return { path: script.scriptId, scriptId: script.scriptId }
			}
		}
		return { path: normalized, scriptId: normalized }
	}

	private parseLocation(location: unknown): { scriptId: string; lineNumber: number; columnNumber?: number } {
		if (!isRecord(location)) {
			throw new CDPError(CdpErrorCode.InvalidParams, "CDP param 'location' is required")
		}
		const scriptId = typeof location.scriptId === 'string' ? location.scriptId : undefined
		if (!scriptId) throw new CDPError(CdpErrorCode.InvalidParams, "CDP param 'location.scriptId' is required")
		return {
			scriptId,
			lineNumber: location.lineNumber as number,
			columnNumber: location.columnNumber as number,
		}
	}

	setConnected(connected: boolean): void {
		this.connected = connected
		if (!connected && this.paused) void this.doResume(Step.None)
		if (!connected) this.clearPendingPaused()
	}

	onScriptParsed(data: ScriptParsedPayload): void {
		const script: KnownScript = {
			scriptId: data.scriptId,
			url: data.url,
			length: data.length,
			endLine: data.endLine,
			normalizedUrl: this.normalizeUrl(data.url),
			normalizedScriptId: this.normalizeUrl(data.scriptId),
		}
		this.knownScripts.set(data.scriptId, script)
		if (this.enabled) {
			this.emitScriptParsed(script)
		} else {
			// Buffer until Debugger.enable so DevTools doesn't miss early scripts.
			this.pendingScriptEvents.push(script)
		}
	}

	private emitScriptParsed(script: KnownScript): void {
		this.lastScriptParsedAt = Date.now()
		this.event('Debugger.scriptParsed', {
			scriptId: script.scriptId,
			url: script.url,
			startLine: 0,
			startColumn: 0,
			endLine: script.endLine ?? 0,
			endColumn: 0,
			executionContextId: 1,
			hash: '',
			isModule: !!script.url && !script.url.startsWith('eval:'),
			length: script.length ?? 0,
		})
	}

	onPaused(p: PausedEvent): void {
		log.debug('debug', () => `onPaused: connected=${this.connected} reason=${p.reason} file=${p.hitFilename} line=${p.hitLine} bps=${this.cdpBreakpoints.size}`)
		if (!this.connected) {
			// No DevTools attached — don't strand the worker at a safepoint.
			this.paused = false
			this.rpc.setPaused(false)
			this.rpc.beginResume(Step.None)
			return
		}
		this.paused = true
		this.rpc.setPaused(true)
		if (!this.enabled) {
			this.pendingPausedEvent = p
			return
		}
		this.pendingPausedEvent = p
		this.flushPendingPausedSoon()
	}

	private emitPaused(p: PausedEvent): void {
		const reason = p.reason ?? 'other'
		const hitBreakpoints: string[] = []
		const hitFile = this.normalizeUrl(p.hitFilename)
		for (const [id, bp] of this.cdpBreakpoints) {
			if (bp.matchUrl === hitFile && bp.line === p.hitLine) hitBreakpoints.push(id)
		}
		const callFrames: CallFrame[] = p.callFrames ?? []
		const payload: {
			callFrames: CallFrame[]
			reason: string
			hitBreakpoints: string[]
			data?: PausedEvent['data']
		} = { callFrames, reason, hitBreakpoints }
		if (p.data !== undefined) payload.data = p.data
		this.event('Debugger.paused', payload)
	}

	private flushPendingPausedSoon(): void {
		if (!this.pendingPausedEvent || !this.connected || !this.enabled || this.pendingPausedTimer != null) return
		const waitMs = Math.max(0, INITIAL_PAUSE_SETTLE_MS - (Date.now() - this.lastScriptParsedAt))
		if (waitMs === 0) {
			const pending = this.pendingPausedEvent
			this.pendingPausedEvent = null
			this.emitPaused(pending)
			return
		}
		this.pendingPausedTimer = timers.setTimeout(() => {
			this.pendingPausedTimer = null
			const pending = this.pendingPausedEvent
			this.pendingPausedEvent = null
			if (!pending || !this.connected || !this.enabled || !this.paused) return
			this.emitPaused(pending)
		}, waitMs)
	}

	private clearPendingPaused(): void {
		this.pendingPausedEvent = null
		if (this.pendingPausedTimer == null) return
		timers.clearTimeout(this.pendingPausedTimer)
		this.pendingPausedTimer = null
	}

	private pauseOnExceptionsStateFrom(state: string): PauseOnExceptionsState {
		switch (state) {
			case 'none':
			case 'caught':
			case 'uncaught':
			case 'all':
				return state
			default:
				throw new CDPError(CdpErrorCode.InvalidParams, `Unsupported pause-on-exceptions state: ${state}`)
		}
	}
}