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

import { PipeKind, type PipeMsg, type WorkerEvent } from '../shared/wire';
import type { RpcMethod } from '../shared/rpc-contract';

type Pipe = CModuleWorker.MessagePipe;
type Pending = { resolve: (v: unknown) => void; reject: (e: unknown) => void };

/** A request handler injected by MainEndpoint. */
export type RequestSink = (method: RpcMethod, params: unknown) => unknown | Promise<unknown>;
/** An event listener injected by WorkerEndpoint. */
export type EventSink = (event: WorkerEvent, params: unknown) => void;

/** Worker side: RPC client + event receiver. */
export class PipeClient {
	private nextId = 1;
	private pending = new Map<number, Pending>();

	/** Main-thread → worker events (Debugger.paused, console, scriptParsed, …). */
	onEvent: EventSink | null = null;

	constructor(private pipe: Pipe) {
		this.pipe.onmessage = (msg: unknown) => this.onMessage(msg as PipeMsg);
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

	private onMessage(msg: PipeMsg): void {
		if (!msg || typeof msg !== 'object') return;
		if (msg.kind === PipeKind.RpcRes) {
			const p = this.pending.get(msg.id);
			if (!p) return;
			this.pending.delete(msg.id);
			if (msg.error) p.reject(new Error(msg.error));
			else p.resolve(msg.result);
		} else if (msg.kind === PipeKind.Event) {
			try { this.onEvent?.(msg.method, msg.params); } catch {}
		}
	}
}

/** Main side: RPC server + event emitter. */
export class PipeServer {
	/** Set by MainEndpoint; dispatches a worker request to a registered handler. */
	onRequest: RequestSink | null = null;

	constructor(private pipe: Pipe) {
		this.pipe.onmessage = (msg: unknown) => this.onMessage(msg as PipeMsg);
		this.pipe.onmessageerror = (err: unknown) => {
			console.error('[pipe-rpc] main pipe error:', err);
		};
	}

	/** Push an event to the worker. Fire-and-forget into the uv pipe buffer. */
	emit(event: WorkerEvent, params: unknown): void {
		this.pipe.postMessage({ kind: PipeKind.Event, method: event, params });
	}

	private async onMessage(msg: PipeMsg): Promise<void> {
		if (!msg || typeof msg !== 'object' || msg.kind !== PipeKind.RpcReq) return;
		const { id, method, params } = msg;
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
