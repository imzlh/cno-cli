/**
 * Base for every CDP domain on the worker: uniform dispatcher wiring and typed
 * param helpers that keep handler params `CdpParams`, never `any`.
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

	/** Read a field the CDP contract guarantees, failing fast on a malformed request. */
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

	/** Reinterpret raw CDP params as a known structure: one cast instead of one per field. */
	protected extract<T extends object>(params: CdpParams): T {
		return params as T
	}
}
