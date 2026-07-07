/**
 * shared base for every CDP domain that runs on the worker.
 *
 * A domain owns a slice of the protocol (Debugger.*, Runtime.*, …). It registers
 * its command handlers on the dispatcher and emits events through `event`. The
 * base keeps the wiring uniform and gives each domain a typed `on()` helper so
 * handler params stay `CdpParams` (never `any`).
 */

import { CDPError, CdpErrorCode, type CDPDispatcher, type CdpParams, type CDPHandler, type EmitEvent } from '../worker/dispatcher'

/** Emits a CDP event toward the front-end. */
export type EventFn = EmitEvent

export abstract class Domain {
	protected constructor(
		protected readonly dispatcher: CDPDispatcher,
		protected readonly event: EventFn,
	) {}

	/** Register a CDP command handler owned by this domain. */
	protected on(method: string, handler: CDPHandler): void {
		this.dispatcher.register(method, handler)
	}

	/** Read a string field from decoded CDP params (undefined when absent). */
	protected str(params: CdpParams, key: string): string | undefined {
		const v = params[key]
		return typeof v === 'string' ? v : undefined
	}

	/**
	 * Read a string field that the CDP contract guarantees is present (e.g. a
	 * requestId / objectId / scriptId on a command). Throws when missing so a
	 * malformed request surfaces immediately instead of silently passing
	 * `undefined` downstream.
	 */
	protected reqStr(params: CdpParams, key: string): string {
		const v = this.str(params, key)
		if (v === undefined) throw new CDPError(CdpErrorCode.InvalidParams, `CDP param '${key}' is required`)
		return v
	}

	/** Read a boolean field from decoded CDP params. */
	protected bool(params: CdpParams, key: string): boolean {
		return params[key] === true
	}

	/** Read a numeric field from decoded CDP params (undefined when absent). */
	protected num(params: CdpParams, key: string): number | undefined {
		const v = params[key]
		return typeof v === 'number' ? v : undefined
	}

	protected reqNonNegativeInt(params: CdpParams, key: string): number {
		const v = this.num(params, key)
		if (v === undefined || !Number.isInteger(v) || v < 0) {
			throw new CDPError(CdpErrorCode.InvalidParams, `CDP param '${key}' must be a non-negative integer`)
		}
		return v
	}

	/**
	 * Treat the raw CDP params as a typed structure. This is a safe narrowing
	 * when the handler immediately accesses known fields — the alternative is
	 * one cast per handler, which is worse.
	 */
	protected extract<T extends object>(params: CdpParams): T {
		return params as T
	}
}
