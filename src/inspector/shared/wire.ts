/**
 * inspector/shared/wire.ts — the pipe envelope plus every event/payload shape
 * shared by both threads.
 *
 * The uv MessagePipe carries three frame kinds (RPC request, RPC response, and
 * main\u2192worker event). Events are tagged by `WorkerEvent`; network payloads carry
 * a `NetFetchKind` / `NetWSKind` discriminator.
 *
 * Enums are plain (not `const enum`) so the bundler/`isolatedModules` stay happy,
 * and members are PascalCase to read as ordinary TS identifiers. Frame
 * `params`/`result` are `unknown`; consumers narrow via the payload interfaces
 * below (keyed off the event/sub-type tag) before touching any field.
 */

import type { RpcMethod } from './rpc-contract'
import type { RemoteObject } from './cdp'

export enum PipeKind {
	RpcReq = 0,  // worker main
	RpcRes = 1,  // main worker
	Event = 2,   // main worker
}

export type PipeMsg =
	| { kind: PipeKind.RpcReq; id: number; method: RpcMethod; params: unknown }
	| { kind: PipeKind.RpcRes; id: number; result?: unknown; error?: string }
	| { kind: PipeKind.Event; method: WorkerEvent; params: unknown }

/** Main-thread worker event names. Single source of truth for emitter & router. */
export enum WorkerEvent {
	Paused = 0,
	Resumed,
	ScriptParsed,
	Console,
	Load,
	BindingCalled,
	NetFetch,
	NetWs,
	FetchIntercept,
	NetServe,
}

/** Sub-type tag carried inside a NetFetch event payload. */
export enum NetFetchKind {
	Req = 0,
	Res = 1,
	Data = 2,
	Done = 3,
}

/** Sub-type tag carried inside a NetWs event payload. */
export enum NetWSKind {
	Created = 0,
	Handshake = 1,
	Recv = 2,
	Sent = 3,
	Closed = 4,
}

//  simple event payloads 
export interface ScriptParsedPayload {
	scriptId: string
	url: string
	sourcePath?: string
	length: number
	endLine: number
}

/** A console argument is just a main-thread-minted RemoteObject. */
export type ConsoleArg = RemoteObject

export interface ConsoleCallFrame {
	functionName: string
	scriptId: string
	url: string
	lineNumber: number
	columnNumber: number
}

export interface ConsolePayload {
	method: string
	args: ConsoleArg[]
	timestamp: number
	callFrames?: ConsoleCallFrame[]
}

export interface LoadPayload {
	timestamp: number
}

export interface BindingCalledPayload {
	name: string
	payload: string
}

export interface FetchInterceptPayload {
	requestId: string
	url: string
	method: string
	headers: Record<string, string>
	postData?: Uint8Array
	resourceType?: string
}

/** Curl-derived timing stamps (seconds); converted to CDP offsets. */
export interface FetchTiming {
	dnsEnd?: number
	connectEnd?: number
	sslEnd?: number
	sendEnd?: number
	receiveHeadersStart?: number
	/** Phase durations (seconds) from curl — used to derive per-phase start times. */
	dnsDuration?: number
	connectDuration?: number
	sslDuration?: number
	sendDuration?: number
	receiveHeadersDuration?: number
	/** CURLINFO_TOTAL_TIME — full request lifetime incl. body download (seconds). */
	totalTime?: number
	/** CURLINFO_SIZE_DOWNLOAD_T — actual bytes received over the wire. */
	sizeDownload?: number
	/** CURLINFO_NUM_CONNECTS — new connections opened (0 = reused). */
	numConnects?: number
	/** CURLINFO_SSL_VERIFYRESULT — 0 = cert OK. */
	sslVerifyResult?: number
	/** CURLINFO_CONTENT_TYPE — Content-Type from response. */
	contentType?: string
	/** CURLINFO_HEADER_SIZE — response header bytes. */
	headerSize?: number
	/** CURLINFO_REDIRECT_COUNT — number of redirects followed. */
	redirectCount?: number
	/** CURLINFO_REDIRECT_URL — redirect target URL. */
	redirectUrl?: string
	requestHeadersText?: string
	responseHeadersText?: string
	debugStart?: number
	headerOutStart?: number
	dataOutStart?: number
	headerInStart?: number
	dataInStart?: number
}

export interface FetchConnection {
	timing?: FetchTiming
	remotePort?: number
	remoteIPAddress?: string
	httpVersion?: number
	downloadSize?: number
}

export type NetworkSource = 'fetch' | 'serve'

export interface NetFetchReq {
	ev: NetFetchKind.Req
	source: 'fetch'
	requestId: string
	timestamp: number
	url: string
	method: string
	headers: Record<string, string>
	status?: number
	postData?: Uint8Array
	callFrames?: ConsoleCallFrame[]
	resourceType?: 'Fetch' | 'XHR'
}

export interface NetFetchRes {
	ev: NetFetchKind.Res
	source: 'fetch'
	requestId: string
	timestamp: number
	url?: string
	status: number
	headers: Record<string, string>
	requestHeaders?: Record<string, string>
	resourceType?: 'Fetch' | 'XHR'
	connection?: FetchConnection
}

export interface NetFetchData {
	ev: NetFetchKind.Data
	source: 'fetch'
	requestId: string
	timestamp: number
	data: Uint8Array
	byteLength: number
}

export interface NetFetchDone {
	ev: NetFetchKind.Done
	source: 'fetch'
	requestId: string
	timestamp: number
	success: boolean
	errorText?: string
	connection?: FetchConnection
	/** Accumulated response body (main-thread buffered). Undefined if no data received. */
	body?: Uint8Array[]
	/** Total byte length of all body chunks. */
	totalBytes?: number
}

export type NetFetchEvent = NetFetchReq | NetFetchRes | NetFetchData | NetFetchDone

export enum NetServeKind {
	Req = 0,
	Res = 1,
	Data = 2,
	Done = 3,
}

export interface NetServeReq {
	ev: NetServeKind.Req
	source: 'serve'
	requestId: string
	timestamp: number
	url: string
	method: string
	headers: Record<string, string>
	postData?: Uint8Array
	callFrames?: ConsoleCallFrame[]
}

export interface NetServeRes {
	ev: NetServeKind.Res
	source: 'serve'
	requestId: string
	timestamp: number
	url: string
	status: number
	statusText?: string
	headers: Record<string, string>
}

export interface NetServeData {
	ev: NetServeKind.Data
	source: 'serve'
	requestId: string
	timestamp: number
	data: Uint8Array
	byteLength: number
}

export interface NetServeDone {
	ev: NetServeKind.Done
	source: 'serve'
	requestId: string
	timestamp: number
	success: boolean
	errorText?: string
	/** Accumulated response body (main-thread buffered). Undefined if no data received. */
	body?: Uint8Array[]
	/** Total byte length of all body chunks. */
	totalBytes?: number
}

export type NetServeEvent = NetServeReq | NetServeRes | NetServeData | NetServeDone

// network: websocket and fetch events
export interface NetWSCreated {
	ev: NetWSKind.Created
	source: NetworkSource
	requestId: string
	url: string
	requestHeaders?: Array<[string, string]>
	callFrames?: ConsoleCallFrame[]
	timestamp: number
}

export interface NetWSHandshake {
	ev: NetWSKind.Handshake
	source: NetworkSource
	requestId: string
	status: number
	headers: Array<[string, string]>
	timestamp: number
}

export interface NetWSFrame {
	ev: NetWSKind.Recv | NetWSKind.Sent
	source: NetworkSource
	requestId: string
	opcode: number
	masked: boolean
	payloadData: string
	payloadLength: number
	timestamp: number
}

export interface NetWSClosed {
	ev: NetWSKind.Closed
	source: NetworkSource
	requestId: string
	code?: number
	reason?: string
	timestamp: number
}

export type NetWSEvent = NetWSCreated | NetWSHandshake | NetWSFrame | NetWSClosed
