/**
 * inspector/shared/cdp.ts — Chrome DevTools Protocol value shapes that travel
 * across the wire (worker ⇄ DevTools, and main → worker as RPC results/events).
 *
 * These are plain data types with no behaviour. The main thread mints
 * RemoteObjects (see main/remote-object.ts); the worker only ever forwards the
 * resulting JSON to DevTools.
 *
 * Dynamic, user-controlled payloads are typed `unknown` rather than `any`, so
 * every consumer is forced to narrow before use.
 */

/** CDP RemoteObject `type` tag. */
export type RemoteObjectType =
	| 'object' | 'function' | 'undefined' | 'string' | 'number' | 'boolean' | 'symbol' | 'bigint';

/** CDP RemoteObject `subtype` tag (object refinement). */
export type RemoteObjectSubtype =
	| 'array' | 'null' | 'node' | 'regexp' | 'date' | 'map' | 'set' | 'weakmap' | 'weakset'
	| 'iterator' | 'generator' | 'error' | 'proxy' | 'promise' | 'typedarray' | 'arraybuffer'
	| 'dataview';

/** A single CDP frame: either a command, a command reply, or an event. */
export interface CDPMessage {
	id?: number;
	method?: string;
	params?: Record<string, unknown>;
	result?: unknown;
	error?: { code: number; message: string };
	sessionId?: string;
}

export interface RemoteObject {
	type: RemoteObjectType;
	subtype?: RemoteObjectSubtype | string;
	className?: string;
	value?: unknown;
	unserializableValue?: string;
	description?: string;
	objectId?: string;
	preview?: ObjectPreview;
}

export interface PropertyPreview {
	name: string;
	type: RemoteObjectType;
	subtype?: RemoteObjectSubtype | string;
	value?: string;
}

export interface ObjectPreview {
	type: RemoteObjectType;
	subtype?: RemoteObjectSubtype | string;
	description?: string;
	overflow: boolean;
	properties: PropertyPreview[];
	entries?: Array<{ key?: ObjectPreview; value: ObjectPreview }>;
}

export interface PropertyDescriptor {
	name: string;
	value?: RemoteObject;
	writable?: boolean;
	configurable?: boolean;
	enumerable?: boolean;
	isOwn?: boolean;
	get?: RemoteObject;
	set?: RemoteObject;
	wasThrown?: boolean;
}

/** An argument passed to Runtime.callFunctionOn / Debugger.setVariableValue. */
export interface RpcCallArgument {
	type?: RemoteObjectType;
	value?: unknown;
	objectId?: string;
	unserializableValue?: string;
}

// ── Debugger domain shapes ────────────────────────────────────────

export interface Location {
	scriptId: string;
	lineNumber: number;
	columnNumber?: number;
}

export type ScopeType =
	| 'global' | 'local' | 'closure' | 'catch' | 'block' | 'script' | 'eval' | 'module' | 'with';

export interface Scope {
	type: ScopeType;
	name?: string;
	object: RemoteObject;
}

export interface CallFrame {
	callFrameId: string;
	functionName: string;
	location: Location;
	url: string;
	scopeChain: Scope[];
	this?: RemoteObject;
	returnValue?: RemoteObject;
}

export interface ExceptionDetails {
	exceptionId: number;
	text: string;
	lineNumber: number;
	columnNumber: number;
	scriptId?: string;
	url?: string;
	exception?: RemoteObject;
}

// ── RPC result shapes (main → worker) ────────────────────────────────

export interface EvaluateResponse {
	result: RemoteObject;
	exceptionDetails?: ExceptionDetails;
}

export interface GetPropertiesResponse {
	result: PropertyDescriptor[];
}

export interface CompileScriptResponse {
	scriptId?: string;
	exceptionDetails?: ExceptionDetails;
}

/** Payload of the WorkerEvent.PAUSED event emitted from the trace handler. */
export interface PausedEvent {
	callFrames: CallFrame[];
	reason: string;
	hitFilename: string;
	hitLine: number;
	data?: RemoteObject;
}

// ── CDP domain parameter shapes (DevTools → worker) ──────────────────

// Runtime domain
export interface RuntimeEvaluateParams {
	expression: string
	objectGroup?: string
	generatePreview?: boolean
	returnByValue?: boolean
	awaitPromise?: boolean
	throwOnSideEffect?: boolean
	replMode?: boolean
	silent?: boolean
}
export interface RuntimeGetPropertiesParams {
	objectId: string
	ownProperties?: boolean
	accessorPropertiesOnly?: boolean
	generatePreview?: boolean
}
export interface RuntimeCallFunctionOnParams {
	objectId?: string
	functionDeclaration: string
	arguments?: RpcCallArgument[]
	returnByValue?: boolean
	generatePreview?: boolean
	objectGroup?: string
	throwOnSideEffect?: boolean
}
export interface RuntimeCompileScriptParams {
	expression: string
	sourceURL?: string
	persistScript?: boolean
}
export interface RuntimeRunScriptParams {
	scriptId: string
	objectGroup?: string
	returnByValue?: boolean
	generatePreview?: boolean
}
export interface RuntimeAwaitPromiseParams {
	promiseObjectId?: string
	objectId?: string
	returnByValue?: boolean
	generatePreview?: boolean
	objectGroup?: string
}

// Debugger domain
export interface SetBreakpointByUrlParams {
	url?: string
	urlRegex?: string
	lineNumber: number
	columnNumber?: number
}
export interface DebuggerEvaluateOnCallFrameParams {
	callFrameId?: string | number
	expression: string
	objectGroup?: string
	returnByValue?: boolean
	generatePreview?: boolean
	throwOnSideEffect?: boolean
}
export interface DebuggerSetVariableValueParams {
	scopeNumber: number
	variableName: string
	newValue: RpcCallArgument
	callFrameId?: string | number
}
export interface DebuggerSetBreakpointParams {
	location: { scriptId?: string; lineNumber?: number; columnNumber?: number }
}

// Fetch domain
export interface FetchContinueRequestParams {
	requestId: string
	url?: string
	method?: string
	headers?: Array<{ name: string; value: string }>
	postData?: string
}
export interface FetchFulfillRequestParams {
	requestId: string
	responseCode: number
	responseHeaders?: Array<{ name: string; value: string }>
	body?: string
}
export interface FetchFailRequestParams {
	requestId: string
	errorReason?: string
	reason?: string
}
export interface FetchContinueResponseParams {
	requestId: string
}
