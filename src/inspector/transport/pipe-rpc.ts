// Async RPC while the main thread's event loop is running.

import { PipeKind, WorkerEvent, isWorkerEvent } from '../shared/wire';
import { isRpcMethod, type RpcMethod } from '../shared/rpc-contract';
import { errMsg, log } from '../../../cts/src/api';

type Pipe = CModuleWorker.MessagePipe;
type Pending = { resolve: (v: unknown) => void; reject: (e: unknown) => void };

/** A request handler injected by MainEndpoint. */
export type RequestSink = (method: RpcMethod, params: unknown) => unknown | Promise<unknown>;
/** An event listener injected by WorkerEndpoint. */
export type EventSink = (event: WorkerEvent, params: unknown) => void;

export interface PipeLifecycle {
	onMessageError?: (error: unknown) => void
	onClose?: () => void
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
	private closed: Error | null = null;

	/** Main-thread → worker events (Debugger.paused, console, scriptParsed, …). */
	onEvent: EventSink | null = null;

	constructor(private pipe: Pipe, private onClose?: (reason: string) => void) {
		this.pipe.onmessage = (msg: unknown) => this.onMessage(msg);
		this.pipe.onmessageerror = (err: unknown) => {
			log.error('pipe-rpc', `worker pipe error: ${err}`);
			this.dispose(`inspector pipe error: ${errMsg(err)}`);
		};
		this.pipe.onclose = () => this.dispose('inspector pipe closed');
	}

	dispose(reason = 'inspector pipe closed'): void {
		if (this.closed) return;
		this.closed = new Error(reason);
		this.pipe.onmessage = undefined;
		this.pipe.onmessageerror = undefined;
		this.pipe.onclose = undefined;
		this.onEvent = null;
		this.failAllPending(reason);
		this.onClose?.(reason);
	}

	/** Reject every outstanding request; for when the transport can no longer reply. */
	failAllPending(reason: string): void {
		const error = new Error(reason);
		for (const pending of this.pending.values()) pending.reject(error);
		this.pending.clear();
	}

	call(method: RpcMethod, params: unknown): Promise<unknown> {
		if (this.closed) return Promise.reject(this.closed);
		const id = this.nextId++;
		return new Promise<unknown>((resolve, reject) => {
			this.pending.set(id, { resolve, reject });
			try {
				this.pipe.postMessage({ kind: PipeKind.RpcReq, id, method, params });
			} catch (e) {
				this.pending.delete(id);
				reject(e instanceof Error ? e : new Error(String(e)));
			}
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

	constructor(private pipe: Pipe, lifecycle: PipeLifecycle = {}) {
		this.pipe.onmessage = (msg: unknown) => this.onMessage(msg);
		this.pipe.onmessageerror = (err: unknown) => {
			log.error('pipe-rpc', `main pipe error: ${err}`);
			try { lifecycle.onMessageError?.(err) } catch {}
		};
		this.pipe.onclose = () => {
			try { lifecycle.onClose?.() } catch {}
		}
	}

	/** Push an event to the worker. Fire-and-forget into the uv pipe buffer. */
	emit(event: WorkerEvent, params: unknown): void {
		this.pipe.postMessage({ kind: PipeKind.Event, method: event, params });
	}

	private async onMessage(msg: unknown): Promise<void> {
		if (!msg || typeof msg !== 'object' || Reflect.get(msg, 'kind') !== PipeKind.RpcReq) return;
		const id = Reflect.get(msg, 'id');
		const method = Reflect.get(msg, 'method');
		if (typeof id !== 'number') return;
		// Requests with an id must receive a reply, including invalid methods.
		if (typeof method !== 'string' || !isRpcMethod(method)) {
			this.reply({ kind: PipeKind.RpcRes, id, error: `unknown rpc method: ${String(method)}` });
			return;
		}
		const params = Reflect.get(msg, 'params');
		try {
			if (!this.onRequest) throw new Error('no request handler registered');
			const result = await this.onRequest(method, params);
			// Non-cloneable results still need an error reply.
			this.reply({ kind: PipeKind.RpcRes, id, result }, () => {
				this.reply({ kind: PipeKind.RpcRes, id, error: `rpc result for ${method} is not transferable` });
			});
		} catch (e) {
			this.reply({ kind: PipeKind.RpcRes, id, error: errMsg(e) });
		}
	}

	// Receive callbacks are not awaited; contain postMessage failures here.
	private reply(payload: Record<string, unknown>, onFail?: () => void): void {
		try {
			this.pipe.postMessage(payload);
		} catch (e) {
			log.error('pipe-rpc', `failed to post rpc reply: ${errMsg(e)}`);
			if (onFail) {
				try { onFail() } catch { /* pipe is gone; nothing left to try */ }
			}
		}
	}
}
