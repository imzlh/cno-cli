// Paused execution cannot pump the main event loop. Inspect RPC uses the
// native channel; control operations also use it while execution is running.

import { log } from '../../../cts/src/api';
import { isRecord } from '../shared/cdp';
import type { DebugChannelMain, DebugChannelWorker } from '../shared/native';
import { ChannelRecv, ChannelReq, ExceptionBreakMode, Step, type StepCode } from '../shared/native';
import { isRpcMethod, type RpcMethod, type RpcParams } from '../shared/rpc-contract';
import { WorkerEvent, isWorkerEvent } from '../shared/wire';

const timers = import.meta.use('timers');

type Pending = { resolve: (v: unknown) => void; reject: (e: unknown) => void };

/** A registered RPC handler resolved synchronously while paused. */
export type SyncDispatch = (method: string, params: Record<string, unknown>) => unknown;

/** Shape of a reply payload carried back over the channel. */
interface ReplyPayload { result?: unknown; error?: string }

type ExceptionBreakpointState = RpcParams['setExceptionBreakpoint']['state'];

function isExceptionBreakpointState(value: unknown): value is ExceptionBreakpointState {
	return value === 'none' || value === 'caught' || value === 'uncaught' || value === 'all'
}

function toStepCode(value: unknown): StepCode {
	const step = typeof value === 'number' ? value | 0 : Step.None
	if (step === Step.Into) return Step.Into
	if (step === Step.Over) return Step.Over
	if (step === Step.Out) return Step.Out
	return Step.None
}

function exceptionBreakModeFromState(state: RpcParams['setExceptionBreakpoint']['state']): number {
	switch (state) {
		case 'none': return ExceptionBreakMode.None;
		case 'caught': return ExceptionBreakMode.Caught;
		case 'uncaught': return ExceptionBreakMode.Uncaught;
		case 'all': return ExceptionBreakMode.All;
	}
}

function emitEventQuietly(
	sink: ((event: WorkerEvent, params: unknown) => void) | null,
	event: WorkerEvent,
	params: unknown
): void {
	try {
		sink?.(event, params);
	} catch {}
}

// ───────────────── Worker side ─────────────────
export class ChannelClient {
	private nextId = 1;
	private pending = new Map<number, Pending>();
	private active = false;
	private pollTimer: number | null = null;
	private closed: Error | null = null;

	/** Main-thread -> worker events delivered over the pause channel. */
	onEvent: ((event: WorkerEvent, params: unknown) => void) | null = null;

	constructor(private dc: DebugChannelWorker) {
		this.pollTimer = timers.setTimeout(this.poll, 0);
	}

	dispose(reason = 'debug channel closed'): void {
		if (this.closed) return;
		this.closed = new Error(reason);
		if (this.pollTimer !== null) timers.clearTimeout(this.pollTimer);
		this.pollTimer = null;
		this.onEvent = null;
		this.failAllPending(this.closed);
		this.dc.stop();
	}

	private failAllPending(error: Error): void {
		for (const pending of this.pending.values()) pending.reject(error);
		this.pending.clear();
	}

	/** Control-class op: applied in C at a safepoint; valid RUNNING or PAUSED. */
	applyControl(method: RpcMethod, params: unknown): void {
		if (this.closed) throw this.closed;
		const record = isRecord(params) ? params : null
		switch (method) {
			case 'addBreakpoint': {
				const url = record && typeof record.url === 'string' ? record.url : null
				const line = record && typeof record.line === 'number' ? record.line : null
				const col = record && typeof record.col === 'number' ? record.col : -1
				if (url === null || line === null) break
				log.debug('debug', () => `channel.control: addBreakpoint ${url}:${line}`);
				this.dc.addBreakpoint(url, line, col);
				break;
			}
			case 'removeBreakpoint': {
				const url = record && typeof record.url === 'string' ? record.url : null
				const line = record && typeof record.line === 'number' ? record.line : null
				if (url === null || line === null) break
				log.debug('debug', () => `channel.control: removeBreakpoint ${url}:${line}`);
				this.dc.removeBreakpoint(url, line);
				break;
			}
			case 'clearBreakpoints':
				this.dc.clearBreakpoints();
				break;
			case 'setBreakpointsActive': {
				this.dc.setBreakpointsActive(!!record?.active);
				break;
			}
			case 'setExceptionBreakpoint': {
				const state = record?.state
				if (!isExceptionBreakpointState(state)) break
				this.dc.setExceptionBreakpoint(exceptionBreakModeFromState(state));
				break;
			}
			case 'requestPause':
				log.debug('debug', () => 'channel.control: requestPause (interrupt)');
				this.dc.interrupt();
				break;
			default:
				log.debug('debug', () => `channel.control: ignoring non-control method ${method}`);
		}
	}

	/** Inspect-class op while PAUSED: send + correlate over the channel. */
	send(method: RpcMethod, params: unknown): Promise<unknown> {
		if (this.closed) return Promise.reject(this.closed);
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
		while (!this.closed) {
			const m = this.dc.recv();
			if (!m) break;
			if (m.kind === ChannelRecv.Reply) {
				const p = this.pending.get(m.id);
				if (p) {
					this.pending.delete(m.id);
					const payload = isRecord(m.payload) ? m.payload : {};
					const error = payload.error;
					if (typeof error === 'string' && error.length > 0) p.reject(new Error(error));
					else p.resolve(payload.result);
				}
			} else if (m.kind === ChannelRecv.Event) {
				if (!isWorkerEvent(m.type)) continue;
				emitEventQuietly(this.onEvent, m.type, m.payload);
			}
		}
	}

	private drainInboxQuietly(): void {
		try {
			this.drainInbox();
		} catch {
			this.dispose();
		}
	}

	// Yield between drains so the WebSocket server can process requests.
	private poll = (): void => {
		if (this.closed) return;
		try {
			this.dc.waitRecv(this.active ? 1 : 20);
		} catch {
			this.dispose();
			return;
		}
		this.drainInboxQuietly();
		if (!this.closed) this.pollTimer = timers.setTimeout(this.poll, 0);
	};

	/** Toggle the paused poll loop; driven by WorkerEndpoint.setPaused. */
	setActive(v: boolean): void {
		if (this.closed || this.active === v) return;
		this.active = v;
		log.debug('debug', () => `channel.setActive: ${v} pending=${this.pending.size}`);
		if (!v) {
			this.drainInboxQuietly();
			this.failAllPending(new Error('Execution resumed'));
		}
	}

	/** Request a pause at the next safepoint (works while RUNNING). */
	interrupt(): void {
		try {
			this.dc.interrupt();
		} catch {}
	}

	/** Read the native run-state from the shared debug control block. */
	state(): number { return this.dc.state() }

	/** Resume the paused main thread, optionally stepping (a Step code). */
	resume(step: StepCode): void {
		try {
			this.dc.resume(step);
		} catch {}
	}
}

// ───────────────── Main side ─────────────────
export class ChannelServer {
	constructor(private dc: DebugChannelMain) {}

	// A dropped Paused event must not enter service(): no resume can arrive.
	emit(event: WorkerEvent, params: unknown): boolean {
		try {
			return this.dc.notify(event, params) !== false;
		} catch {
			return false;
		}
	}

	private replyQuietly(id: number, resp: ReplyPayload): void {
		try {
			this.dc.reply(id, resp);
		} catch {}
	}

	// waitRequest applies control operations in C while waiting for inspect/resume.
	service(dispatchSync: SyncDispatch): StepCode {
		while (true) {
			let req: ReturnType<DebugChannelMain['waitRequest']>;
			try { req = this.dc.waitRequest(); }
			catch (e) {
				log.debug('debug', () => `channel.service: waitRequest threw: ${e}`);
				return Step.None; // channel torn down (EAGAIN from dc.stop())
			}

			if (req.kind === ChannelReq.Resume) {
				const step = Reflect.get(req, 'step');
				log.debug('debug', () => `channel.service: resume step=${String(step)}`);
				return toStepCode(step);
			}

			const id = Reflect.get(req, 'id');
			const method = Reflect.get(req, 'method');
			const raw = Reflect.get(req, 'params');
			const params = isRecord(raw) ? raw : {};
			let resp: ReplyPayload;
			if (typeof id !== 'number' || typeof method !== 'string' || !isRpcMethod(method)) {
				log.debug('debug', () => `channel.service: invalid inspect request, req keys=${Object.keys(req).join(',')}`);
				resp = { error: `invalid inspect request` };
			} else {
				try { resp = { result: dispatchSync(method, params) }; }
				catch (e) { resp = { error: e instanceof Error ? e.message : String(e) }; }
			}
			if (typeof id === 'number') this.replyQuietly(id, resp);
		}
	}
}
