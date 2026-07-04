/**
 * inspector/transport/channel-rpc.ts — the native DebugChannel transport.
 *
 * Used while the program is PAUSED: inside the QuickJS onBreak trace handler the
 * main thread is frozen and its uv loop cannot be pumped, so inspect
 * requests/replies and the resume signal travel over the channel's lock-free
 * rings + semaphores instead.
 *
 *   ChannelClient (worker) — control ops (always), inspect ops (while paused),
 *                            resume/interrupt, and the reply poll loop.
 *   ChannelServer (main)   — the blocking service loop run from inside onBreak.
 *
 * Control-class operations are applied in C at the next safepoint, so they work
 * whether the program is RUNNING or PAUSED — the worker drives them straight
 * over the channel regardless of run state.
 */

import { ChannelRecv, ChannelReq, ExceptionBreakMode, Step, type StepCode } from '../shared/native';
import type { DebugChannelMain, DebugChannelWorker } from '../shared/native';
import type { RpcMethod, RpcParams } from '../shared/rpc-contract';
import type { WorkerEvent } from '../shared/wire';
import { log } from '../../../cts/src/api';

const timers = import.meta.use('timers');

type Pending = { resolve: (v: unknown) => void; reject: (e: unknown) => void };

/** A registered RPC handler resolved synchronously while paused. */
export type SyncDispatch = (method: string, params: Record<string, unknown>) => unknown;

/** Shape of a reply payload carried back over the channel. */
interface ReplyPayload { result?: unknown; error?: string }

function exceptionBreakModeFromState(state: RpcParams['setExceptionBreakpoint']['state']): number {
	switch (state) {
		case 'none': return ExceptionBreakMode.None;
		case 'caught': return ExceptionBreakMode.Caught;
		case 'uncaught': return ExceptionBreakMode.Uncaught;
		case 'all': return ExceptionBreakMode.All;
	}
}

// ───────────────── Worker side ─────────────────
export class ChannelClient {
	private nextId = 1;
	private pending = new Map<number, Pending>();
	private active = false;
	private pollTimer: number | null = null;

	/** Main-thread -> worker events delivered over the pause channel. */
	onEvent: ((event: WorkerEvent, params: unknown) => void) | null = null;

	constructor(private dc: DebugChannelWorker) {
		this.pollTimer = timers.setTimeout(this.poll, 0);
	}

	/** Control-class op: applied in C at a safepoint; valid RUNNING or PAUSED. */
	applyControl(method: RpcMethod, params: unknown): void {
		switch (method) {
			case 'addBreakpoint': {
				const p = params as RpcParams['addBreakpoint'];
				log.debug('debug', () => `channel.control: addBreakpoint ${p.url}:${p.line}`);
				this.dc.addBreakpoint(p.url, p.line, p.col ?? -1);
				break;
			}
			case 'removeBreakpoint': {
				const p = params as RpcParams['removeBreakpoint'];
				log.debug('debug', () => `channel.control: removeBreakpoint ${p.url}:${p.line}`);
				this.dc.removeBreakpoint(p.url, p.line);
				break;
			}
			case 'clearBreakpoints':
				this.dc.clearBreakpoints();
				break;
			case 'setBreakpointsActive': {
				const p = params as RpcParams['setBreakpointsActive'];
				this.dc.setBreakpointsActive(!!p.active);
				break;
			}
			case 'setExceptionBreakpoint': {
				const p = params as RpcParams['setExceptionBreakpoint'];
				this.dc.setExceptionBreakpoint(exceptionBreakModeFromState(p.state));
				break;
			}
			case 'requestPause':
				log.debug('debug', () => 'channel.control: requestPause (interrupt)');
				this.dc.interrupt();
				break;
			default:
				// Non-control method routed here by mistake — impossible given the
				// contract, but keep it loud in debug builds.
				log.debug('debug', () => `channel.control: ignoring non-control method ${method}`);
		}
	}

	/** Inspect-class op while PAUSED: send + correlate over the channel. */
	send(method: RpcMethod, params: unknown): Promise<unknown> {
		const id = this.nextId++;
		return new Promise<unknown>((resolve, reject) => {
			this.pending.set(id, { resolve, reject });
			try {
				const ok = this.dc.send(id, method, params);
				if (!ok) {
					this.pending.delete(id);
					reject(new Error('debug channel send failed (queue full)'));
				}
			} catch (e) {
				this.pending.delete(id);
				reject(e instanceof Error ? e : new Error(String(e)));
			}
		});
	}

	private drainInbox(): void {
		for (;;) {
			let m: ReturnType<DebugChannelWorker['recv']>;
			try { m = this.dc.recv(); } catch { break; }
			if (!m) break;
			if (m.kind === ChannelRecv.Reply) {
				const p = this.pending.get(m.id);
				if (p) {
					this.pending.delete(m.id);
					const resp = (m.payload ?? {}) as ReplyPayload;
					if (resp.error) p.reject(new Error(resp.error));
					else p.resolve(resp.result);
				}
			} else if (m.kind === ChannelRecv.Event) {
				try { this.onEvent?.(m.type as WorkerEvent, m.payload); } catch {}
			}
		}
	}

	/**
	 * Drain replies on a short timer so the worker's uv loop (WS server) keeps
	 * breathing between drains. waitRecv sleeps up to 1ms when idle to avoid a
	 * hot spin without adding latency.
	 */
	private poll = (): void => {
		const waitMs = this.active ? 1 : 20;
		try { this.dc.waitRecv(waitMs); } catch {}
		try { this.drainInbox(); } catch {}
		this.pollTimer = timers.setTimeout(this.poll, 0);
	};

	/** Toggle the paused poll loop; driven by WorkerEndpoint.setPaused. */
	setActive(v: boolean): void {
		if (this.active === v) return;
		this.active = v;
		log.debug('debug', () => `channel.setActive: ${v} pending=${this.pending.size}`);
		if (!v) {
			// Drain final replies, then fail anything outstanding so no CDP command
			// hangs across the resume boundary.
			try { this.drainInbox(); } catch {}
			for (const [, p] of this.pending) p.reject(new Error('Execution resumed'));
			this.pending.clear();
		}
	}

	/** Request a pause at the next safepoint (works while RUNNING). */
	interrupt(): void { try { this.dc.interrupt(); } catch {} }

	/** Read the native run-state from the shared debug control block. */
	state(): number { return this.dc.state() }

	/** Resume the paused main thread, optionally stepping (a Step code). */
	resume(step: StepCode): void { try { this.dc.resume(step); } catch {} }
}

// ───────────────── Main side ─────────────────
export class ChannelServer {
	constructor(private dc: DebugChannelMain) {}

	/** Push an event to the worker while the main thread is paused in onBreak. */
	emit(event: WorkerEvent, params: unknown): void {
		try { this.dc.notify(event, params); } catch {}
	}

	/**
	 * Synchronous service loop, run from inside onBreak while the main thread is
	 * frozen. Blocks on the channel's main semaphore (no busy spin); control
	 * messages (breakpoints/step) are applied in C by waitRequest and never
	 * surface here. Returns the requested step code when the worker resumes.
	 */
	service(dispatchSync: SyncDispatch): StepCode {
		for (;;) {
			let req: ReturnType<DebugChannelMain['waitRequest']>;
			try { req = this.dc.waitRequest(); }
			catch (e) {
				log.debug('debug', () => `channel.service: waitRequest threw: ${e}`);
				return Step.None; // channel torn down (EAGAIN from dc.stop())
			}

			if (req.kind === ChannelReq.Resume) {
				const resumeReq = req as typeof req & { step: number };
				log.debug('debug', () => `channel.service: resume step=${resumeReq.step}`);
				return ((resumeReq.step | 0) || Step.None) as StepCode;
			}

			// req.kind === Inspect. Narrow the union so TypeScript knows which fields exist.
			const inspectReq = req as Extract<typeof req, { kind: number; id: number; method: string; params: unknown }>;
			const method = inspectReq.method;
			const raw: unknown = inspectReq.params;
			const params = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
			let resp: ReplyPayload;
			if (!method) {
				log.debug('debug', () => `channel.service: inspect id=${inspectReq.id} has no method, req keys=${Object.keys(inspectReq).join(',')}`);
				resp = { error: `missing method on inspect request (id=${inspectReq.id})` };
			} else {
				try { resp = { result: dispatchSync(method, params) }; }
				catch (e) { resp = { error: e instanceof Error ? e.message : String(e) }; }
			}
			try { this.dc.reply(inspectReq.id, resp); } catch {}
		}
		return Step.None;
	}
}


