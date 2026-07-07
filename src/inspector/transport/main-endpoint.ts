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
import { isRpcMethod, type RpcMethod, type RpcParams } from '../shared/rpc-contract';
import { isRecord } from '../shared/cdp';
import type { DebugChannelMain, StepCode } from '../shared/native';
import { WorkerEvent } from '../shared/wire';
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
		for (const key of Object.keys(table)) {
			if (!isRpcMethod(key)) continue;
			const h = table[key];
			if (h) this.handlers.set(key, h as ErasedHandler);
		}
	}

	/** Push an event to the worker. Paused must use the synchronous channel. */
	emit(event: WorkerEvent, params: unknown): void {
		if (event === WorkerEvent.Paused) {
			this.channelServer.emit(event, params);
			return;
		}
		this.pipeServer.emit(event, params);
	}

	/** Synchronous service loop, invoked from inside onBreak. Returns resume step. */
	serviceWhilePaused(): StepCode {
		return this.channelServer.service((method, params) => this.dispatchSync(method, params));
	}

	private dispatchAsync(method: string, params: unknown): unknown | Promise<unknown> {
		const h = this.handlers.get(method);
		if (!h) throw new Error(`unknown rpc method: ${method}`);
		return h(isRecord(params) ? params : {});
	}

	private dispatchSync(method: string, params: Record<string, unknown>): unknown {
		const h = this.handlers.get(method);
		if (!h) throw new Error(`unknown rpc method: ${method}`);
		const r = h(params);
		if (r && (typeof r === 'object' || typeof r === 'function') && typeof Reflect.get(r, 'then') === 'function') {
			throw new Error(`rpc method ${method} returned a Promise during pause (must be synchronous)`);
		}
		return r;
	}
}
