/**
 * Debugger CDP domain (worker): breakpoint bookkeeping and the pause/resume
 * state machine. Breakpoints and stepping are control-class RPCs applied in C
 * at a safepoint; source/eval queries use the inspect transport.
 */

import { fileUrlToPath, log, toPosixPath } from '../../../cts/src/api'
import type {
	CallFrame,
	DebuggerEvaluateOnCallFrameParams,
	DebuggerSetBreakpointParams,
	DebuggerSetVariableValueParams,
	PausedEvent,
	SetBreakpointByUrlParams,
} from '../shared/cdp'
import { isRecord } from '../shared/cdp'
import { isSideEffectFree, sideEffectException } from './side-effect'
import { Step, type StepCode } from '../shared/native'
import type { PauseOnExceptionsState } from '../shared/rpc-contract'
import type { ScriptParsedPayload } from '../shared/wire'
import type { WorkerEndpoint } from '../transport/worker-endpoint'
import { CDPError, CdpErrorCode, type CDPDispatcher, type EmitEvent } from '../worker/dispatcher'
import { Domain } from './base'

const timers = import.meta.use('timers')
const INITIAL_PAUSE_SETTLE_MS = 50
/**
 * How long a pause may be held when the socket is attached but `Debugger.enable`
 * has not arrived — the --inspect-brk startup race. Unbounded, it would park the
 * main thread in serviceWhilePaused() forever; the timer is cancelled the moment
 * enable arrives, so it expires only when no debugger is coming at all.
 */
const UNENABLED_PAUSE_GRACE_MS = 2000

interface KnownScript {
	scriptId: string
	url: string
	/** Host/VFS localPath when it differs from scriptId (CJS frames use this). */
	sourcePath?: string
	length?: number
	endLine?: number
	normalizedUrl: string
	normalizedScriptId: string
	normalizedSourcePath?: string
}

interface CdpBreakpoint {
	/** Primary path sent to native (prefer engine module name = scriptId). */
	url: string
	/** Alternate native path (localPath) when ESM name ≠ CJS filename. */
	altUrl?: string
	matchUrl: string
	matchAltUrl?: string
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
	private pendingPausedEvent: PausedEvent | null = null
	private pendingPausedTimer: number | null = null
	/** Bounds a pause held because Debugger is not enabled yet. See onPaused. */
	private unenabledPauseTimer: number | null = null
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
			// The frontend is here: any bounded hold from onPaused has served its purpose
			// and flushPendingPausedSoon below takes over delivery of the held event.
			this.clearUnenabledPauseTimeout()
			// Idempotent, like V8: a second enable replays nothing, because a
			// duplicate scriptParsed duplicates the file in the sources tree. A
			// disable/enable cycle does replay, since `disable` clears `enabled`.
			if (!this.enabled) {
				this.enabled = true
				// knownScripts is a superset of the old pending list, so replaying
				// only that list hid every script loaded before a disable/enable.
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
				if (bp) await this.removeNativeBreakpoint(bp)
			}
			this.cdpBreakpoints.clear()
			if (this.pauseOnExceptionsState !== 'none') {
				this.pauseOnExceptionsState = 'none'
				await this.rpc.call('setExceptionBreakpoint', { state: 'none' })
			}
			// Disabling while paused must let the program continue (V8 does);
			// otherwise the main thread stays parked at the safepoint forever.
			if (this.paused) await this.doResume(Step.None)
			else await this.rpc.call('releaseObjectGroup', { objectGroup: 'backtrace' })
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

		this.on('Debugger.setBreakpointsActive', async (p) => {
			const active = this.bool(p, 'active')
			// BPs set while inactive stay only in cdpBreakpoints — install on re-enable.
			if (active && !this.breakpointsActive) {
				for (const bp of this.cdpBreakpoints.values()) {
					await this.installNativeBreakpoint(bp)
				}
			}
			this.breakpointsActive = active
			return this.rpc.call('setBreakpointsActive', { active })
		})

		this.on('Debugger.setBreakpointByUrl', (p) => {
			const q = this.extract<SetBreakpointByUrlParams>(p)
			// CDP requires one script locator: url, urlRegex or scriptHash. Only the
			// no-locator case is rejected; a locator that cannot become a path keeps
			// the lenient early return below, so no existing DevTools call changes.
			if (p.url === undefined && p.urlRegex === undefined && p.scriptHash === undefined) {
				throw new CDPError(CdpErrorCode.InvalidParams, "CDP param 'url', 'urlRegex' or 'scriptHash' is required")
			}
			const rawUrl = q.url ?? this.urlFromRegex(q.urlRegex)
			if (!rawUrl) return { breakpointId: '', locations: [] }
			const lineNumber = this.requireLineNumber(q.lineNumber)
			const columnNumber = q.columnNumber
			const resolved = this.resolveScriptPath(rawUrl)
			const breakpointId = `bp-${this.nextBpId++}`
			const line = lineNumber + 1
			const col = columnNumber != null && columnNumber > 0 ? columnNumber + 1 : undefined
			const bp = this.makeBreakpoint(resolved.path, resolved.altPath, line, col)
			this.cdpBreakpoints.set(breakpointId, bp)
			if (this.breakpointsActive) this.installNativeBreakpointSafely(bp)
			return {
				breakpointId,
				locations: [{ scriptId: resolved.scriptId, lineNumber, columnNumber: columnNumber ?? 0 }],
			}
		})
		this.on('Debugger.setBreakpoint', (p) => {
			const q = this.extract<DebuggerSetBreakpointParams>(p)
			const loc = this.parseLocation(q.location)
			this.requireLineNumber(loc.lineNumber)
			const resolved = this.resolveScriptPath(loc.scriptId)
			const breakpointId = `bp-${this.nextBpId++}`
			const line = loc.lineNumber + 1
			const col = loc.columnNumber != null && loc.columnNumber > 0 ? loc.columnNumber + 1 : undefined
			const bp = this.makeBreakpoint(resolved.path, resolved.altPath, line, col)
			this.cdpBreakpoints.set(breakpointId, bp)
			if (this.breakpointsActive) this.installNativeBreakpointSafely(bp)
			return { breakpointId, actualLocation: loc }
		})
		this.on('Debugger.removeBreakpoint', async (p) => {
			const id = this.reqStr(p, 'breakpointId')
			const bp = this.cdpBreakpoints.get(id)
			if (bp) {
				this.cdpBreakpoints.delete(id)
				await this.removeNativeBreakpoint(bp)
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
			// Node answers {"code":-32000,"message":"Can only perform operation while
			// paused."}; a fabricated exceptionDetails would print a bogus error.
			if (!this.paused) {
				throw new CDPError(CdpErrorCode.ServerError, 'Can only perform operation while paused.')
			}
			const q = this.extract<DebuggerEvaluateOnCallFrameParams>(p)
			// NOTE: side-effect.ts is a permissive BLOCKLIST, not a sandbox —
			// instance-method calls (`arr.pop()`, `process.exit(1)`) pass it, so a
			// preview can still mutate or kill the debuggee.
			if (q.throwOnSideEffect && !isSideEffectFree(q.expression)) return sideEffectException()
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
			// Paused-only: setVariableValue addresses the stack at
			// FrameOffset.PausedSetVariable, meaningful only while serviceWhilePaused
			// is blocked; while RUNNING it would write unrelated frames. Gate on
			// `paused` (set once onPaused ran, when scopeChainLengths becomes valid),
			// not rpc.isPaused(), which is true before that event is processed.
			if (!this.paused) {
				throw new CDPError(CdpErrorCode.ServerError, 'Can only perform operation while paused.')
			}
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

	/** Normalise a file URL or native path to the form used for breakpoint comparison. */
	private normalizeUrl(url: string): string {
		if (url.startsWith('file:')) {
			try {
				return this.normalizePath(fileUrlToPath(url))
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

	/**
	 * Map a DevTools url/scriptId to native breakpoint paths.
	 * ESM frames use scriptId (module name); CJS frames use localPath/sourcePath.
	 */
	private resolveScriptPath(rawUrl: string): { path: string; altPath?: string; scriptId: string } {
		const normalized = this.normalizeUrl(rawUrl)
		for (const script of this.knownScripts.values()) {
			if (
				script.normalizedUrl === normalized
				|| script.normalizedScriptId === normalized
				|| (script.normalizedSourcePath !== undefined && script.normalizedSourcePath === normalized)
			) {
				const alt = script.sourcePath
					&& this.normalizeUrl(script.sourcePath) !== this.normalizeUrl(script.scriptId)
					? script.sourcePath
					: undefined
				return { path: script.scriptId, altPath: alt, scriptId: script.scriptId }
			}
		}
		return { path: normalized, scriptId: normalized }
	}

	private makeBreakpoint(url: string, altUrl: string | undefined, line: number, col?: number): CdpBreakpoint {
		const matchUrl = this.normalizeUrl(url)
		const matchAltUrl = altUrl ? this.normalizeUrl(altUrl) : undefined
		return {
			url,
			altUrl: matchAltUrl && matchAltUrl !== matchUrl ? altUrl : undefined,
			matchUrl,
			matchAltUrl: matchAltUrl && matchAltUrl !== matchUrl ? matchAltUrl : undefined,
			line,
			col,
		}
	}

	/**
	 * The rejection MUST be swallowed: the worker's `unhandledrejection` listener
	 * reports a worker crash, which rejects the attach `ready` promise and aborts
	 * the session. pipe-rpc's `failAllPending` makes that reachable.
	 */
	private installNativeBreakpointSafely(bp: CdpBreakpoint): void {
		this.installNativeBreakpoint(bp).catch((e: unknown) => {
			log.debug('debug', () => `addBreakpoint ${bp.url}:${bp.line} failed: ${e instanceof Error ? e.message : String(e)}`)
		})
	}

	private async installNativeBreakpoint(bp: CdpBreakpoint): Promise<void> {
		await this.rpc.call('addBreakpoint', { url: bp.url, line: bp.line, col: bp.col })
		// CJS debug frames use localPath; ESM uses module name — register both.
		if (bp.altUrl) await this.rpc.call('addBreakpoint', { url: bp.altUrl, line: bp.line, col: bp.col })
	}

	private async removeNativeBreakpoint(bp: CdpBreakpoint): Promise<void> {
		await this.rpc.call('removeBreakpoint', { url: bp.url, line: bp.line })
		if (bp.altUrl) await this.rpc.call('removeBreakpoint', { url: bp.altUrl, line: bp.line })
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
		if (connected) return
		// doResume awaits releaseObjectGroup over the pipe, and this path runs when
		// the socket is going away — an orphan rejection is reported as a crash.
		if (this.paused) {
			this.doResume(Step.None).catch((e: unknown) => {
				log.debug('debug', () => `resume on detach failed: ${e instanceof Error ? e.message : String(e)}`)
			})
		}
		this.clearPendingPaused()
		// `enabled` is per-session state in V8, so a reattaching frontend's
		// Debugger.enable must replay the full script tree again.
		this.enabled = false
	}

	onScriptParsed(data: ScriptParsedPayload): void {
		const sourcePath = data.sourcePath && data.sourcePath !== data.scriptId ? data.sourcePath : undefined
		const script: KnownScript = {
			scriptId: data.scriptId,
			url: data.url,
			sourcePath,
			length: data.length,
			endLine: data.endLine,
			normalizedUrl: this.normalizeUrl(data.url),
			normalizedScriptId: this.normalizeUrl(data.scriptId),
			normalizedSourcePath: sourcePath ? this.normalizeUrl(sourcePath) : undefined,
		}
		this.knownScripts.set(data.scriptId, script)
		// Not enabled yet: knownScripts is replayed wholesale on Debugger.enable.
		if (this.enabled) this.emitScriptParsed(script)
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
		this.pendingPausedEvent = p
		if (!this.enabled) {
			// Connected but Debugger not enabled: the --inspect-brk race, or a
			// session that never enables Debugger. Hold the event so
			// Debugger.enable flushes it (break-on-start stays deterministic), but
			// bound the hold so a frontend that never asks cannot freeze the
			// debuggee forever.
			this.armUnenabledPauseTimeout()
			return
		}
		this.flushPendingPausedSoon()
	}

	/**
	 * Resume once if a pause is still held with Debugger disabled. Mirrors the
	 * synchronous `!connected` branch of onPaused rather than doResume(), whose
	 * pipe await could reject from a timer callback into an unhandledrejection.
	 * No Debugger.resumed is emitted because no Debugger.paused ever was.
	 */
	private armUnenabledPauseTimeout(): void {
		if (this.unenabledPauseTimer != null) return
		this.unenabledPauseTimer = timers.setTimeout(() => {
			this.unenabledPauseTimer = null
			if (!this.paused || this.enabled || !this.pendingPausedEvent) return
			log.debug('debug', () => 'onPaused: held pause expired with Debugger still disabled — resuming')
			this.pendingPausedEvent = null
			this.paused = false
			this.rpc.setPaused(false)
			this.rpc.beginResume(Step.None)
		}, UNENABLED_PAUSE_GRACE_MS)
	}

	private clearUnenabledPauseTimeout(): void {
		if (this.unenabledPauseTimer == null) return
		timers.clearTimeout(this.unenabledPauseTimer)
		this.unenabledPauseTimer = null
	}

	private emitPaused(p: PausedEvent): void {
		const reason = p.reason ?? 'other'
		const hitBreakpoints: string[] = []
		// hitFilename is the frame's devtools url; breakpoints are keyed on the
		// scriptId (specPath). For non-file modules (npm:/jsr:) the two differ, so
		// compare against both or hitBreakpoints is always empty there.
		const hitFiles = new Set<string>([this.normalizeUrl(p.hitFilename)])
		const topScriptId = p.callFrames?.[0]?.location?.scriptId
		if (topScriptId) hitFiles.add(this.normalizeUrl(topScriptId))
		for (const [id, bp] of this.cdpBreakpoints) {
			const pathHit = hitFiles.has(bp.matchUrl)
				|| (bp.matchAltUrl !== undefined && hitFiles.has(bp.matchAltUrl))
			if (pathHit && bp.line === p.hitLine) hitBreakpoints.push(id)
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
		this.clearUnenabledPauseTimeout()
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

	// CDP lineNumber is 0-based; negative or non-integer is InvalidParams.
	private requireLineNumber(lineNumber: unknown): number {
		if (typeof lineNumber !== 'number' || !Number.isInteger(lineNumber) || lineNumber < 0) {
			throw new CDPError(CdpErrorCode.InvalidParams, `Invalid breakpoint lineNumber: ${String(lineNumber)}`)
		}
		return lineNumber
	}
}
