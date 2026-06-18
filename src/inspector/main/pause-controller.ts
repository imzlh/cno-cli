/**
 * main/pause-controller.ts — the onBreak safepoint handler.
 *
 * When the engine pauses, this builds the CDP call-frame stack (locals,
 * closures, `this`, global) from the native frame API, ships a Paused event to
 * the worker, then blocks in the synchronous service loop until DevTools asks
 * to resume \u2014 returning the requested step mode to the engine.
 */

import { BreakReason, Step, native, type StepCode } from '../shared/native'
import { isUserFile } from '../shared/user-files'
import type { CallFrame, PausedEvent, Scope } from '../shared/cdp'
import { WorkerEvent } from '../shared/wire'
import type { MainEndpoint } from '../transport/main-endpoint'
import type { Serializer } from './remote-object'
import { log } from '../../../cts/src/utils/log'

const BACKTRACE_GROUP = 'backtrace'
const EVAL_FRAME_OFFSET = 4

interface TopFrame {
	file: string
	func: string
	line: number
	column: number
}

export class PauseController {
	private lastStepMode: StepCode = Step.None

	constructor(
		private readonly endpoint: MainEndpoint,
		private readonly serializer: Serializer,
		private readonly isConnected: () => boolean,
	) {}

	/** Native onBreak callback. Returns 0 to continue execution. */
	onBreak(reason: number, file: string, func: string, line: number, column: number): number {
		if (!this.isConnected()) return 0

		if (!isUserFile(file)) {
			// Keep stepping through internal frames instead of surfacing them.
			if (reason === BreakReason.Step && this.lastStepMode > Step.None) native.step(this.lastStepMode)
			return 0
		}

		log.debug('debug', () => `onBreak: reason=${reason} file=${file} line=${line} col=${column}`)
		this.serializer.releaseGroup(BACKTRACE_GROUP)

		const top: TopFrame = { file, func, line, column }
		const depth = native.getStackDepth()
		const callFrames: CallFrame[] = []
		for (let level = 0; level < depth; level++) try {
			const frame = this.buildCallFrame(level, top)
			if (frame) callFrames.push(frame)
		} catch {}

		if (callFrames.length === 0) {
			log.debug('debug', () => `onBreak: no call frames`)
			// Keep stepping through internal frames instead of surfacing them.
			if (reason === BreakReason.Step && this.lastStepMode > Step.None)
				native.step(this.lastStepMode)
			return 0
		}

		const payload: PausedEvent = {
			callFrames,
			reason: reasonString(reason),
			hitFilename: file,
			hitLine: line,
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

	private buildCallFrame(level: number, top: TopFrame): CallFrame | null {
		let locals: ReturnType<typeof native.getLocalVariables> = []
		let thisVal: unknown
		let frameInfo: { file: string; line: number; column: number; func: { name?: string } } | null = null
		try {
			locals = native.getLocalVariables(level + EVAL_FRAME_OFFSET)
		} catch (e) {
			log.debug('debug', () => `getLocalVariables(${level}) threw: ${e}`)
		}
		try {
			thisVal = native.evalInFrame(level + EVAL_FRAME_OFFSET, 'this')
		} catch {}
		try {
			frameInfo = native.getFrameInfo(level + EVAL_FRAME_OFFSET)
		} catch {}

		// Null-prototype so getProperties(ownProperties:false) doesn't walk
		// up to Object.prototype and surface its methods as fake variables.
		const localObj = Object.create(null) as Record<string, unknown>
		const closureObj = Object.create(null) as Record<string, unknown>
		let hasClosure = false
		for (const v of locals) {
			if (v.isClosure) {
				closureObj[v.name] = v.value
				hasClosure = true
			} else {
				localObj[v.name] = v.value
			}
		}

		let fFile = level === 0 ? top.file : ''
		let fLine = level === 0 ? top.line : 0
		let fCol = level === 0 ? top.column : 0
		let frameName = level === 0 ? top.func : ''

		if (frameInfo) {
			// For the top frame (level 0), keep the trace callback's exact
			// location — it points precisely at the debugger statement or
			// breakpoint. getFrameInfo can report a coarser position.
			if (level > 0) {
				if (frameInfo.file) fFile = frameInfo.file
				if (frameInfo.line != null) fLine = frameInfo.line
				if (frameInfo.column != null) fCol = frameInfo.column
			}
			const fn = frameInfo.func?.name
			if (fn && fn !== '<eval>') frameName = fn
		}

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

		return {
			callFrameId: String(level),
			functionName: frameName,
			location: {
				scriptId: fFile,
				lineNumber: Math.max(0, fLine - 1),
				columnNumber: Math.max(0, fCol - 1),
			},
			url: fFile,
			scopeChain,
			this: this.serializer.serialize(thisVal, BACKTRACE_GROUP),
			returnValue: { type: 'undefined' },
		}
	}
}

function reasonString(reason: number): string {
	switch (reason) {
		case BreakReason.Exception:
			return 'exception'
		case BreakReason.Step:
			return 'step'
		case BreakReason.Debugger:
			return 'other'
		default:
			return 'breakpoint'
	}
}
