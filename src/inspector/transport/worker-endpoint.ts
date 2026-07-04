/**
 * inspector/transport/worker-endpoint.ts — the worker's single RPC facade.
 *
 * Replaces the old WorkerRPC. It composes the two transports and routes every
 * call purely from the shared contract:
 *
 *   control            → channel (applyControl), valid in any run state.
 *   inspect/lifecycle  → channel while PAUSED, pipe while RUNNING.
 *
 * Because identity and transport both come from `rpc-contract.ts`, a method can
 * never again be sent over the wrong transport — the historical breakpoint bug
 * (control ops silently falling through to the pipe) is structurally impossible.
 */

import { PipeClient } from './pipe-rpc';
import { ChannelClient } from './channel-rpc';
import { isControlMethod, transportOf, type RpcMethod, type RpcParams } from '../shared/rpc-contract';
import { DebugState } from '../shared/native';
import type { DebugChannelWorker, StepCode } from '../shared/native';
import type { WorkerEvent } from '../shared/wire';
type Pipe = CModuleWorker.MessagePipe;

export class WorkerEndpoint {
	private pipe: PipeClient;
	private channel: ChannelClient;
	private paused = false;

	/** Events pushed from the main thread (paused, console, scriptParsed, …). */
	onEvent: ((event: WorkerEvent, params: unknown) => void) | null = null;

	constructor(pipe: Pipe, dc: DebugChannelWorker) {
		this.pipe = new PipeClient(pipe);
		this.channel = new ChannelClient(dc);
		this.pipe.onEvent = (event, params) => { try { this.onEvent?.(event, params); } catch {} };
	}

	/** Invoke a main-thread handler (inspect) or apply a control op. */
	call<M extends RpcMethod>(method: M, params: RpcParams[M] = {} as RpcParams[M]): Promise<unknown> {
		if (isControlMethod(method)) {
			try {
				this.channel.applyControl(method, params)
			} catch (e) {
				return Promise.reject(e instanceof Error ? e : new Error(String(e)))
			}
			return Promise.resolve({})
		}
		const transport = transportOf(method)
		if (transport === 'lifecycle') return this.pipe.call(method, params)
		return this.paused ? this.channel.send(method, params) : this.pipe.call(method, params);
	}

	/** Flip transport mode. Driven by doResume / setConnected in DebuggerDomain. */
	setPaused(v: boolean): void {
		if (this.paused === v) return;
		this.paused = v;
		this.channel.setActive(v);
	}

	/** Whether the main thread is currently paused at a safepoint. */
	isPaused(): boolean {
		if (this.paused) return true
		try {
			return this.channel.state() === DebugState.Paused
		} catch {
			return this.paused
		}
	}

	/** Request a pause at the next safepoint (works while RUNNING). */
	signalInterrupt(): void { this.channel.interrupt(); }

	/** Resume the paused main thread, optionally stepping (a Step code). */
	beginResume(step: StepCode): void { this.channel.resume(step); }
}
