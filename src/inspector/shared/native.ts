/**
 * inspector/shared/native.ts — the single point of contact with the native
 * `debug` module (QuickJS debugger primitives + cross-thread DebugChannel).
 *
 * Every other file imports its native constants from here instead of reaching
 * for bare `debug.FOO` references. This gives us:
 *   • one `import.meta.use('debug')` to reason about, and
 *   • clean, well-named TypeScript groupings for the otherwise-flat constant
 *     soup the native module exposes (break reasons, step modes, channel ops).
 *
 * Available on BOTH threads: the main thread drives execution/inspection and
 * the worker owns the channel handle, so both legitimately use this module.
 */

export const native = import.meta.use('debug');

/** Why the main thread stopped at a safepoint (the onBreak `reason` argument). */
export const BreakReason = {
	Breakpoint: native.BREAKPOINT,
	Exception: native.EXCEPTION,
	/** `debugger;` statement (JS_DEBUG_TRACE_DEBUGGER_STMT). */
	Debugger: native.DEBUGGER,
	/** A step (into/over/out) finished one line. */
	Step: native.STEP,
	/** Explicit pause via dc.interrupt() (Debugger.pause CDP command). */
	Interrupt: native.INTERRUPT,
} as const;

/**
 * Step / resume codes. `None` (0) doubles as "plain continue": it is the value
 * handed to `dc.resume()` / `step()` when no stepping is requested.
 */
export const Step = {
	None: native.STEP_NONE,
	Into: native.STEP_INTO,
	Over: native.STEP_OVER,
	Out: native.STEP_OUT,
} as const;

/** A concrete step code value (0–3). */
export type StepCode = (typeof Step)[keyof typeof Step];

export const ExceptionBreakMode = {
	None: native.EXCEPTION_NONE,
	Caught: native.EXCEPTION_CAUGHT,
	Uncaught: native.EXCEPTION_UNCAUGHT,
	All: native.EXCEPTION_ALL,
} as const;

export type ExceptionBreakModeCode = (typeof ExceptionBreakMode)[keyof typeof ExceptionBreakMode];

export const DebugState = {
	Idle: native.STATE_IDLE,
	Running: native.STATE_RUNNING,
	Paused: native.STATE_PAUSED,
} as const;

/** Kinds returned by DebugChannelWorker.recv() (main → worker queue). */
export const ChannelRecv = {
	Event: native.RES_EVENT,
	Reply: native.RES_REPLY,
} as const;

/** Kinds returned by DebugChannelMain.waitRequest() (worker → main queue). */
export const ChannelReq = {
	Inspect: native.REQ_INSPECT,
	Resume: native.REQ_RESUME,
} as const;

// ── Derived native value types (kept in lock-step with the C API) ──────────────

/** One entry of native.getLocalVariables(level). */
export interface LocalVariable {
	name: string
	value: unknown
	isArg: boolean
	isClosure: boolean
	/** True when the variable is in the temporal dead zone (let/const before its declaration). */
	isUninitialized?: boolean
	scopeLevel: number
}

/** Non-null result of native.getFrameInfo(level). */
export type FrameInfo = NonNullable<ReturnType<typeof native.getFrameInfo>>;

/** The pair returned by native.createDebugChannel(). */
export type DebugChannelPair = CModuleDebug.DebugChannelPair;
export type DebugChannelMain = CModuleDebug.DebugChannelMain;
export type DebugChannelWorker = CModuleDebug.DebugChannelWorker;
