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
import { errMsg, log } from '../../../cts/src/api';
import type { DebugChannelWorker, StepCode } from '../shared/native';
import type { WorkerEvent } from '../shared/wire';
type Pipe = CModuleWorker.MessagePipe;

function emitWorkerEventQuietly(
	sink: ((event: WorkerEvent, params: unknown) => void) | null,
	event: WorkerEvent,
	params: unknown
): void {
	try {
		sink?.(event, params);
	} catch {}
}

export class WorkerEndpoint {
	private pipe: PipeClient;
	private channel: ChannelClient;
	private paused = false;

	/** Events pushed from the main thread (paused, console, scriptParsed, …). */
	onEvent: ((event: WorkerEvent, params: unknown) => void) | null = null;

	constructor(pipe: Pipe, dc: DebugChannelWorker) {
		this.pipe = new PipeClient(pipe);
		this.channel = new ChannelClient(dc);
		this.pipe.onEvent = (event, params) => emitWorkerEventQuietly(this.onEvent, event, params);
		this.channel.onEvent = (event, params) => emitWorkerEventQuietly(this.onEvent, event, params);
	}

	/** Invoke a main-thread handler (inspect) or apply a control op. */
	call<M extends RpcMethod>(method: M, params: RpcParams[M]): Promise<unknown> {
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

	/**
	 * Fire-and-forget call. Use this instead of `void call(...)` whenever nobody
	 * awaits the result: a rejected orphan promise reaches the worker's
	 * `unhandledrejection` listener, which reports it to the main thread as a worker
	 * crash. A dying pipe would otherwise manufacture a phantom crash report for
	 * every in-flight notify.
	 */
	notify<M extends RpcMethod>(method: M, params: RpcParams[M]): void {
		try {
			void this.call(method, params).catch((e: unknown) => {
				log.debug('debug', () => `rpc notify ${method} failed: ${errMsg(e)}`)
			})
		} catch (e) {
			log.debug('debug', () => `rpc notify ${method} threw: ${errMsg(e)}`)
		}
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
