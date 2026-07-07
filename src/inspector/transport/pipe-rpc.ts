/**
 * inspector/transport/pipe-rpc.ts — the async uv MessagePipe transport.
 *
 * Used while the program is RUNNING: the main thread is pumping its event loop,
 * so inspect/eval RPC and all main→worker events flow over the pipe.
 *
 *   PipeClient  (worker) — sends RPC requests, receives replies + events.
 *   PipeServer  (main)   — answers RPC requests, emits events.
 *
 * Neither side knows anything about method semantics; routing decisions live in
 * the endpoints. The server delegates request handling to an injected callback
 * so the handler registry can be owned in one place (MainEndpoint).
 */

import { PipeKind, WorkerEvent } from '../shared/wire';
import { isRpcMethod, type RpcMethod } from '../shared/rpc-contract';

type Pipe = CModuleWorker.MessagePipe;
type Pending = { resolve: (v: unknown) => void; reject: (e: unknown) => void };

/** A request handler injected by MainEndpoint. */
export type RequestSink = (method: RpcMethod, params: unknown) => unknown | Promise<unknown>;
/** An event listener injected by WorkerEndpoint. */
export type EventSink = (event: WorkerEvent, params: unknown) => void;

function isWorkerEvent(value: unknown): value is WorkerEvent {
	return typeof value === 'number' && WorkerEvent[value] !== undefined
}

function emitEventQuietly(sink: EventSink | null, event: WorkerEvent, params: unknown): void {
	try {
		sink?.(event, params);
	} catch {}
}

/** Worker side: RPC client + event receiver. */
export class PipeClient {
	private nextId = 1;
	private pending = new Map<number, Pending>();

	/** Main-thread → worker events (Debugger.paused, console, scriptParsed, …). */
	onEvent: EventSink | null = null;

	constructor(private pipe: Pipe) {
		this.pipe.onmessage = (msg: unknown) => this.onMessage(msg);
		this.pipe.onmessageerror = (err: unknown) => {
			console.error('[pipe-rpc] worker pipe error:', err);
		};
	}

	call(method: RpcMethod, params: unknown): Promise<unknown> {
		const id = this.nextId++;
		return new Promise<unknown>((resolve, reject) => {
			this.pending.set(id, { resolve, reject });
			this.pipe.postMessage({ kind: PipeKind.RpcReq, id, method, params });
		});
	}

	private onMessage(msg: unknown): void {
		if (!msg || typeof msg !== 'object') return;
		const kind = Reflect.get(msg, 'kind');
		if (kind === PipeKind.RpcRes) {
			const id = Reflect.get(msg, 'id');
			if (typeof id !== 'number') return;
			const p = this.pending.get(id);
			if (!p) return;
			this.pending.delete(id);
			const error = Reflect.get(msg, 'error');
			if (typeof error === 'string' && error.length > 0) p.reject(new Error(error));
			else p.resolve(Reflect.get(msg, 'result'));
			} else if (kind === PipeKind.Event) {
				const method = Reflect.get(msg, 'method');
				if (!isWorkerEvent(method)) return;
				emitEventQuietly(this.onEvent, method, Reflect.get(msg, 'params'));
			}
		}
	}

/** Main side: RPC server + event emitter. */
export class PipeServer {
	/** Set by MainEndpoint; dispatches a worker request to a registered handler. */
	onRequest: RequestSink | null = null;

	constructor(private pipe: Pipe) {
		this.pipe.onmessage = (msg: unknown) => this.onMessage(msg);
		this.pipe.onmessageerror = (err: unknown) => {
			console.error('[pipe-rpc] main pipe error:', err);
		};
	}

	/** Push an event to the worker. Fire-and-forget into the uv pipe buffer. */
	emit(event: WorkerEvent, params: unknown): void {
		this.pipe.postMessage({ kind: PipeKind.Event, method: event, params });
	}

	private async onMessage(msg: unknown): Promise<void> {
		if (!msg || typeof msg !== 'object' || Reflect.get(msg, 'kind') !== PipeKind.RpcReq) return;
		const id = Reflect.get(msg, 'id');
		const method = Reflect.get(msg, 'method');
		if (typeof id !== 'number' || typeof method !== 'string' || !isRpcMethod(method)) return;
		const params = Reflect.get(msg, 'params');
		try {
			if (!this.onRequest) throw new Error('no request handler registered');
			const result = await this.onRequest(method, params);
			this.pipe.postMessage({ kind: PipeKind.RpcRes, id, result });
		} catch (e) {
			this.pipe.postMessage({ kind: PipeKind.RpcRes, id, error: errMsg(e) });
		}
	}
}

function errMsg(e: unknown): string {
	return e instanceof Error ? e.message : String(e);
}
