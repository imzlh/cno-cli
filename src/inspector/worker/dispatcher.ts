/**
 * worker/dispatcher.ts — routes "Domain.method" CDP commands to handlers.
 *
 * The worker speaks raw CDP coming off the WebSocket. Each domain registers the
 * methods it owns; unknown methods resolve to `undefined` so the connection
 * layer can reply with an empty `{}` (DevTools tolerates this for optional
 * commands).
 *
 * CDP params arrive as decoded JSON, i.e. an untyped object. We model that as
 * `CdpParams` (a `Record<string, unknown>`) and let each handler narrow the
 * exact fields it needs — no `any` enters the domain code.
 */

/** Decoded CDP command params: arbitrary JSON object, narrowed per-handler. */
export type CdpParams = Record<string, unknown>

/** A CDP command handler. Returns the command result (or a promise of it). */
export type CDPHandler = (params: CdpParams) => unknown | Promise<unknown>

/** Emits a CDP event (`{ method, params }`) toward the connected front-end. */
export type EmitEvent = (method: string, params: unknown) => void

export class CDPDispatcher {
	private handlers = new Map<string, CDPHandler>()

	register(method: string, handler: CDPHandler): void {
		this.handlers.set(method, handler)
	}

	registerMany(table: Record<string, CDPHandler>): void {
		for (const method of Object.keys(table)) this.handlers.set(method, table[method]!)
	}

	has(method: string): boolean {
		return this.handlers.has(method)
	}

	/** Returns the handler result, or throws for unknown methods. */
	async dispatch(method: string, params: CdpParams): Promise<unknown> {
		const h = this.handlers.get(method)
		if (!h) throw new Error(`Unknown CDP method: ${method}`)
		return await h(params)
	}
}
