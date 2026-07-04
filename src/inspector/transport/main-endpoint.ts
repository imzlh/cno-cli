/**
 * inspector/transport/main-endpoint.ts — the main thread's single RPC facade.
 *
 * Replaces the old MainRpc. Owns the handler registry (shared by both the async
 * pipe path while RUNNING and the synchronous channel path while PAUSED), emits
 * events to the worker, and exposes the blocking pause service loop.
 *
 * A method registered once here is reachable over whichever transport the
 * worker chooses, so 'evaluate' (say) works identically running or paused.
 */

import { PipeServer } from './pipe-rpc';
import { ChannelServer } from './channel-rpc';
import type { RpcMethod, RpcParams } from '../shared/rpc-contract';
import type { DebugChannelMain, StepCode } from '../shared/native';
import type { WorkerEvent } from '../shared/wire';
import { log } from '../../../cts/src/api';

type Pipe = CModuleWorker.MessagePipe;

/** A handler for a single RPC method, strongly typed by its params. */
export type RpcHandler<M extends RpcMethod> = (params: RpcParams[M]) => unknown | Promise<unknown>;

/** A partial table of handlers, used by registerMany. */
export type RpcHandlerTable = { [M in RpcMethod]?: RpcHandler<M> };

/** Internal erased handler shape stored in the registry. */
type ErasedHandler = (params: Record<string, unknown>) => unknown | Promise<unknown>;

export class MainEndpoint {
	private pipeServer: PipeServer;
	private channelServer: ChannelServer;
	private handlers = new Map<string, ErasedHandler>();

	constructor(pipe: Pipe, dc: DebugChannelMain) {
		this.pipeServer = new PipeServer(pipe);
		this.pipeServer.onRequest = (method, params) => this.dispatchAsync(method, params);
		this.channelServer = new ChannelServer(dc);
	}

	/** Register an RPC method. Handlers may be async (used only while RUNNING). */
	register<M extends RpcMethod>(method: M, handler: RpcHandler<M>): void {
		this.handlers.set(method, handler as ErasedHandler);
	}

	registerMany(table: RpcHandlerTable): void {
		for (const key of Object.keys(table) as RpcMethod[]) {
			const h = table[key];
			if (h) this.handlers.set(key, h as ErasedHandler);
		}
	}

	/** Push an event to the worker (rides the pipe even while paused). */
	emit(event: WorkerEvent, params: unknown): void {
		this.pipeServer.emit(event, params);
	}

	/** Synchronous service loop, invoked from inside onBreak. Returns resume step. */
	serviceWhilePaused(): StepCode {
		return this.channelServer.service((method, params) => this.dispatchSync(method, params));
	}

	private dispatchAsync(method: string, params: unknown): unknown | Promise<unknown> {
		const h = this.handlers.get(method);
		if (!h) throw new Error(`unknown rpc method: ${method}`);
		return h((params ?? {}) as Record<string, unknown>);
	}

	private dispatchSync(method: string, params: Record<string, unknown>): unknown {
		const h = this.handlers.get(method);
		if (!h) throw new Error(`unknown rpc method: ${method}`);
		const r = h(params);
		if (r && typeof (r as { then?: unknown }).then === 'function') {
			throw new Error(`rpc method ${method} returned a Promise during pause (must be synchronous)`);
		}
		return r;
	}
}
