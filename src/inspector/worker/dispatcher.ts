/**
 * worker/dispatcher.ts — routes "Domain.method" CDP commands to handlers.
 *
 * The worker speaks raw CDP coming off the WebSocket. Each domain registers the
 * methods it owns; unknown methods are reported with the CDP/JSON-RPC
 * "method not found" code so frontend failures stay diagnosable.
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

export class CDPError extends Error {
	constructor(readonly code: number, message: string, readonly data?: unknown) {
		super(message)
		this.name = 'CDPError'
	}
}

export const CdpErrorCode = {
	ParseError: -32700,
	InvalidRequest: -32600,
	MethodNotFound: -32601,
	InvalidParams: -32602,
	InternalError: -32603,
} as const

export interface CdpErrorPayload {
	code: number
	message: string
	data?: unknown
}

export function formatCdpError(err: unknown): CdpErrorPayload {
	if (err instanceof CDPError) {
		const out: CdpErrorPayload = { code: err.code, message: err.message }
		if (err.data !== undefined) out.data = err.data
		return out
	}
	const message = err instanceof Error ? err.message : String(err)
	return { code: CdpErrorCode.InternalError, message }
}

export class CDPDispatcher {
	private handlers = new Map<string, CDPHandler>()

	register(method: string, handler: CDPHandler): void {
		this.handlers.set(method, handler)
	}

	registerMany(table: Record<string, CDPHandler>): void {
		for (const method of Object.keys(table)) {
			const handler = table[method]
			if (handler) this.handlers.set(method, handler)
		}
	}

	has(method: string): boolean {
		return this.handlers.has(method)
	}

	/** Returns the handler result, or throws for unknown methods. */
	async dispatch(method: string, params: CdpParams): Promise<unknown> {
		const h = this.handlers.get(method)
		if (!h) throw new CDPError(CdpErrorCode.MethodNotFound, `Unknown CDP method: ${method}`)
		return await h(params)
	}
}
