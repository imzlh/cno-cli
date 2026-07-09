/**
 * main/pause-controller.ts — the onBreak safepoint handler.
 *
 * When the engine pauses, this builds the CDP call-frame stack (locals,
 * closures, `this`, global) from the native frame API, ships a Paused event to
 * the worker, then blocks in the synchronous service loop until DevTools asks
 * to resume — returning the requested step mode to the engine.
 */

import { log } from '../../../cts/src/api'
import type { CallFrame, PausedEvent, Scope } from '../shared/cdp'
import { remapConsoleFrameDetailed, type SourceMapLookup } from '../shared/console-utils'
import { BreakReason, Step, native, type LocalVariable, type StepCode } from '../shared/native'
import { isUserFile } from '../shared/user-files'
import { WorkerEvent } from '../shared/wire'
import type { MainEndpoint } from '../transport/main-endpoint'
import type { Serializer } from './remote-object'

const BACKTRACE_GROUP = 'backtrace'
const EVAL_FRAME_OFFSET = 4
const sourcemap = import.meta.use('sourcemap') as SourceMapLookup

const createScopeObject = (): Record<string, unknown> => Object.create(null)

interface TopFrame {
	file: string
	func: string
	line: number
	column: number
}

export class PauseController {
	private lastStepMode: StepCode = Step.None
	private scopeChainLengths = new Map<string, number>()

	constructor(
		private readonly endpoint: MainEndpoint,
		private readonly serializer: Serializer,
		private readonly isConnected: () => boolean,
	) { }

	/** Native onBreak callback. Returns 0 to continue execution. */
	onBreak(reason: number, file: string, func: string, line: number, column: number, thrown?: unknown): number {
		if (!this.isConnected()) return 0

		log.debug('debug', () => `onBreak: reason=${reason} file=${file} line=${line} col=${column}`)
		this.serializer.releaseGroup(BACKTRACE_GROUP)
		this.scopeChainLengths.clear()

		const top: TopFrame = { file, func, line, column }
		const preferTopHint = this.hasUsableTopHint(top)
		const depth = native.getStackDepth()
		const callFrames: CallFrame[] = []
		for (let level = 0; level < depth; level++) {
			try {
				const frame = this.buildCallFrame(level, top, preferTopHint)
				if (frame) callFrames.push(frame)
			} catch { }
		}

		if (callFrames.length === 0) {
			log.debug('debug', () => 'onBreak: no call frames')
			this.continueSteppingIfNeeded(reason)
			return 0
		}

		const firstUserFrame = this.firstUserFrameIndex(callFrames)
		if (firstUserFrame < 0) {
			log.debug('debug', () => `onBreak: skipped internal pause reason=${reason}`)
			this.continueSteppingIfNeeded(reason)
			return 0
		}
		if (firstUserFrame > 0) callFrames.splice(0, firstUserFrame)

		const hit = callFrames[0]
		const hitFilename = hit?.url || hit?.location?.scriptId || file
		const hitLine = (hit?.location?.lineNumber ?? line - 1) + 1

		const payload: PausedEvent = {
			callFrames,
			reason: reasonString(reason),
			hitFilename,
			hitLine,
			data: this.pauseData(reason, thrown),
		}
		this.endpoint.emit(WorkerEvent.Paused, payload)

		const step = this.endpoint.serviceWhilePaused()
		log.debug('debug', () => `onBreak: resumed step=${step}`)
		if (step > Step.None) {
			this.lastStepMode = step
			native.step(step)
		}
		return 0
	}

	private buildCallFrame(level: number, top: TopFrame, preferTopHint: boolean): CallFrame | null {
		let locals: LocalVariable[] = []
		let thisVal: unknown
		let hasThisVal = false
		let frameInfo: { file: string; line: number; column: number; func: { name?: string } } | null = null
		try {
			locals = native.getLocalVariables(level + EVAL_FRAME_OFFSET)
		} catch (e) {
			log.debug('debug', () => `getLocalVariables(${level}) threw: ${e}`)
		}
		try {
			thisVal = native.evalInFrame(level + EVAL_FRAME_OFFSET, 'this')
			hasThisVal = true
		} catch { }
		try {
			frameInfo = native.getFrameInfo(level + EVAL_FRAME_OFFSET)
		} catch { }

		const localObj = createScopeObject()
		const closureObj = createScopeObject()
		let hasClosure = false
		for (const v of locals) {
			if (v.isUninitialized) continue  // TDZ: declared in bytecode but not yet reached at this PC
			if (v.isClosure) {
				closureObj[v.name] = v.value
				hasClosure = true
			} else {
				localObj[v.name] = v.value
			}
		}

		const useTopHint = level === 0 && preferTopHint
		let fFile = useTopHint ? top.file : ''
		let fLine = useTopHint ? top.line : 0
		let fCol = useTopHint ? top.column : 0
		let frameName = useTopHint ? top.func : ''

		if (frameInfo) {
			// Exception pauses can arrive without a usable top-level source hint,
			// so fall back to getFrameInfo in that case.
			if (level > 0 || !useTopHint) {
				if (frameInfo.file) fFile = frameInfo.file
				if (frameInfo.line != null) fLine = frameInfo.line
				if (frameInfo.column != null) fCol = frameInfo.column
			}
			const fn = frameInfo.func?.name
			if (fn && fn !== '<eval>') frameName = fn
		}

		let mapped = remapConsoleFrameDetailed(fFile, fLine, fCol, sourcemap)
		if (!mapped.found && frameInfo && useTopHint) {
			mapped = remapConsoleFrameDetailed(frameInfo.file, frameInfo.line, frameInfo.column, sourcemap)
		}
		fFile = mapped.filePath
		fLine = mapped.lineNumber + 1
		fCol = mapped.columnNumber + 1

		const scopeChain: Scope[] = [
			{
				type: 'local',
				name: frameName || '(anonymous)',
				object: this.serializer.serialize(localObj, BACKTRACE_GROUP),
			},
		]
		if (hasClosure) {
			scopeChain.push({ type: 'closure', object: this.serializer.serialize(closureObj, BACKTRACE_GROUP) })
		}
		scopeChain.push({ type: 'global', object: this.serializer.serialize(globalThis, BACKTRACE_GROUP) })

		const id = String(level)
		this.scopeChainLengths.set(id, scopeChain.length)

		const callFrame: CallFrame = {
			callFrameId: id,
			functionName: frameName,
			location: {
				scriptId: fFile,
				lineNumber: fLine - 1,
				columnNumber: fCol - 1,
			},
			url: fFile,
			scopeChain,
		}
		if (hasThisVal && thisVal !== undefined) {
			callFrame.this = this.serializer.serialize(thisVal, BACKTRACE_GROUP)
		}
		return callFrame
	}

	private hasUsableTopHint(top: TopFrame): boolean {
		return top.line > 0 && isUserFile(top.file)
	}

	private firstUserFrameIndex(callFrames: CallFrame[]): number {
		for (let i = 0; i < callFrames.length; i++) {
			const frame = callFrames[i]
			if (!frame) continue
			if (isUserFile(frame.url || frame.location.scriptId)) return i
		}
		return -1
	}

	private continueSteppingIfNeeded(reason: number): void {
		if (reason === BreakReason.Step && this.lastStepMode > Step.None) {
			native.step(this.lastStepMode)
		}
	}

	private pauseData(reason: number, thrown: unknown) {
		if (reason !== BreakReason.Exception) return undefined
		return this.serializer.serialize(thrown, BACKTRACE_GROUP, { preview: true })
	}

	/**
	 * Convert a CDP scope index to the C-layer semantic scope number.
	 * CDP scopeNumber is an index into the call frame's scopeChain array
	 * ([local, closure?, global], length 2 or 3). The C layer expects:
	 *   0 = args+locals, 1 = closures, 2 = global.
	 */
	normalizeScope(callFrameId: string, cdpScopeNumber: number): number {
		const len = this.scopeChainLengths.get(callFrameId)
		if (len == null) return cdpScopeNumber
		if (cdpScopeNumber === 0) return 0
		if (cdpScopeNumber === len - 1) return 2
		return 1
	}
}

function reasonString(reason: number): string {
	switch (reason) {
		case BreakReason.Exception:
			return 'exception'
		case BreakReason.Step:
			return 'step'
		case BreakReason.Interrupt:
			return 'debugCommand'
		case BreakReason.Debugger:
			return 'other'
		default:
			return 'breakpoint'
	}
}
