/**
 * main/evaluator.ts — expression evaluation and script compilation.
 *
 * Owns the engine-facing side of Runtime.evaluate / Debugger.evaluateOnCallFrame
 * / Runtime.callFunctionOn / compileScript / runScript. While paused it uses
 * the native in-frame evaluator; while running it uses the async engine eval.
 * Results are turned into RemoteObjects by the shared Serializer.
 */

import { native } from '../shared/native'
import { containsAwait } from '../domains/side-effect'
import type {
	CompileScriptResponse,
	EvaluateResponse,
	ExceptionDetails,
	RemoteObject,
	RemoteObjectType,
	RpcCallArgument,
} from '../shared/cdp'
import type { RpcParams } from '../shared/rpc-contract'
import type { Serializer } from './remote-object'

const engine = import.meta.use('engine')

function isThenable(v: unknown): v is PromiseLike<unknown> {
	return typeof v === 'object' && v !== null && typeof (v as { then?: unknown }).then === 'function'
}

function unwrapEvalResult(v: unknown): unknown {
	if (v && typeof v === 'object' && 'value' in v) return (v as { value: unknown }).value
	return v
}

/** Build a returnByValue RemoteObject (value embedded, no objectId). */
function byValue(val: unknown): RemoteObject {
	if (typeof val === 'undefined') return { type: 'undefined' }
	if (typeof val === 'number') return serializeNumber(val)
	if (typeof val === 'bigint') return { type: 'bigint', unserializableValue: `${val}n`, description: `${val}n` }
	if (typeof val === 'symbol') return { type: 'symbol', description: safeString(val) }
	if (typeof val === 'function') return { type: 'function', description: safeFnString(val as Function) }
	const t = typeof val
	const type: RemoteObjectType = val === null ? 'object' : (t as RemoteObjectType)
	return { type, value: jsonSafeValue(val) }
}

const EVAL_FRAME_OFFSET = 9

export class Evaluator {
	private readonly compiledScripts = new Map<string, { mod: CModuleEngine.Module; persist: boolean }>()

	constructor(private readonly serializer: Serializer) {}

	/** Synchronous evaluate — for use while paused (dispatchSync rejects Promises). */
	evaluateSync(q: RpcParams['evaluate']): EvaluateResponse {
		const group = q.objectGroup ?? 'backtrace'
		try {
			if (containsAwait(q.expression)) {
				return this.errorResult(new Error('Cannot evaluate `await` expression while paused'))
			}
			const level = Number(q.callFrameId ?? 0) || 0
			const val = native.evalInFrame(level + EVAL_FRAME_OFFSET, q.expression)
			if (q.returnByValue) return { result: byValue(val) }
			return { result: this.serializer.serialize(val, group, { preview: !!q.generatePreview }) }
		} catch (e) {
			return this.errorResult(e)
		}
	}

	async evaluate(q: RpcParams['evaluate']): Promise<EvaluateResponse> {
		const paused = !!q.paused
		const group = q.objectGroup ?? (paused ? 'backtrace' : 'runtime')
		try {
			let val: unknown
			if (paused) {
				if (containsAwait(q.expression)) {
					return this.errorResult(new Error('Cannot evaluate `await` expression while paused'))
				}
				const level = Number(q.callFrameId ?? 0) || 0
				val = native.evalInFrame(level + EVAL_FRAME_OFFSET, q.expression)
			} else {
				const raw = engine.eval<unknown>(q.expression, '<devtools>', engine.EVAL_ASYNC | engine.EVAL_NEW_BACKTRACE)
				val = unwrapEvalResult(await raw)
				if (q.awaitPromise && isThenable(val)) val = await val
			}
			if (q.returnByValue) return { result: byValue(val) }
			return { result: this.serializer.serialize(val, group, { preview: !!q.generatePreview }) }
		} catch (e) {
			return this.errorResult(e)
		}
	}

	async callFunctionOn(q: RpcParams['callFunctionOn']): Promise<EvaluateResponse> {
		const group = q.objectGroup ?? 'runtime'
		try {
			const target = q.objectId ? this.serializer.resolve(q.objectId) : undefined
			const args = (q.arguments ?? []).map((a) => this.resolveArgument(a))
			const factory = engine.eval<unknown>(`(${q.functionDeclaration})`, '<devtools>', engine.EVAL_ASYNC | engine.EVAL_NEW_BACKTRACE)
			const fn = unwrapEvalResult(await factory)
			if (typeof fn !== 'function') throw new TypeError('callFunctionOn: declaration is not a function')
			let val: unknown = (fn as Function).apply(target, args)
			if (isThenable(val)) val = await val
			if (q.returnByValue) return { result: byValue(val) }
			return { result: this.serializer.serialize(val, group, { preview: !!q.generatePreview }) }
		} catch (e) {
			return this.errorResult(e)
		}
	}

	callFunctionOnSync(q: RpcParams['callFunctionOn']): EvaluateResponse {
		const group = q.objectGroup ?? 'runtime'
		try {
			const target = q.objectId ? this.serializer.resolve(q.objectId) : undefined
			const args = (q.arguments ?? []).map((a) => this.resolveArgument(a))
			const factory = engine.eval<unknown>(`(${q.functionDeclaration})`, '<devtools>', engine.EVAL_NEW_BACKTRACE)
			const fn = unwrapEvalResult(factory)
			if (typeof fn !== 'function') throw new TypeError('callFunctionOn: declaration is not a function')
			let val: unknown = (fn as Function).apply(target, args)
			if (q.returnByValue) return { result: byValue(val) }
			return { result: this.serializer.serialize(val, group, { preview: !!q.generatePreview }) }
		} catch (e) {
			return this.errorResult(e)
		}
	}

	async awaitPromise(q: RpcParams['awaitPromise']): Promise<EvaluateResponse> {
		const group = q.objectGroup ?? 'runtime'
		try {
			const promise = this.serializer.resolve(q.promiseObjectId)
			if (!isThenable(promise)) {
				throw new TypeError('awaitPromise: objectId does not resolve to a Promise')
			}
			const val = await promise
			if (q.returnByValue) return { result: byValue(val) }
			return { result: this.serializer.serialize(val, group, { preview: !!q.generatePreview }) }
		} catch (e) {
			return this.errorResult(e)
		}
	}

	awaitPromiseSync(q: RpcParams['awaitPromise']): EvaluateResponse {
		return this.errorResult(new Error('Cannot await promise while paused'))
	}

	compileScript(q: RpcParams['compileScript']): CompileScriptResponse {
		const sourceURL = q.sourceURL || '<compiled>'
		try {
			const mod = new engine.Module(`(${q.expression})`, sourceURL)
			const scriptId = `script:${q.sourceURL || Date.now()}`
			this.compiledScripts.set(scriptId, { mod, persist: !!q.persistScript })
			return { scriptId }
		} catch (e) {
			return { exceptionDetails: compileError(e) }
		}
	}

	async runScript(q: RpcParams['runScript']): Promise<EvaluateResponse> {
		const group = q.objectGroup ?? 'runtime'
		const entry = this.compiledScripts.get(q.scriptId)
		if (!entry) return this.errorResult(new Error(`unknown scriptId: ${q.scriptId}`))
		try {
			await entry.mod.eval()
			const val = entry.mod.namespace.default
			if (!entry.persist) this.compiledScripts.delete(q.scriptId)
			if (q.returnByValue) return { result: byValue(val) }
			return { result: this.serializer.serialize(val, group, { preview: !!q.generatePreview }) }
		} catch (e) {
			return this.errorResult(e)
		}
	}

	runScriptSync(q: RpcParams['runScript']): EvaluateResponse {
		return this.errorResult(new Error(`Cannot run script while paused: ${q.scriptId}`))
	}

	/** Resolve a CDP CallArgument to a real JS value (objectId / unserializable / literal). */
	resolveArgument(a: RpcCallArgument): unknown {
		if (a.objectId) return this.serializer.resolve(a.objectId)
		if (a.unserializableValue !== undefined) {
			const u = a.unserializableValue
			if (u === 'Infinity') return Infinity
			if (u === '-Infinity') return -Infinity
			if (u === '-0') return -0
			if (u === 'NaN') return NaN
			if (u.endsWith('n')) {
				try {
					return BigInt(u.slice(0, -1))
				} catch {
					return undefined
				}
			}
			// Unknown unserializable value — log and return undefined rather than silently swallowing.
			try { (import.meta.use('console') as { warn: (...a: unknown[]) => void }).warn(`unknown unserializableValue: ${u}`) } catch { /* ignore */ }
			return undefined
		}
		return a.value
	}

	private errorResult(e: unknown): EvaluateResponse {
		const err = e as { stack?: string; message?: string } | undefined
		const message = err?.message ?? String(e)
		const description = err?.stack ?? message
		const exception: RemoteObject = { type: 'object', subtype: 'error', className: 'Error', description }
		return {
			result: exception,
			exceptionDetails: { text: message, exceptionId: 1, lineNumber: 0, columnNumber: 0, exception },
		}
	}
}

function serializeNumber(value: number): RemoteObject {
	if (Number.isNaN(value)) return { type: 'number', unserializableValue: 'NaN', description: 'NaN' }
	if (value === Infinity) return { type: 'number', unserializableValue: 'Infinity', description: 'Infinity' }
	if (value === -Infinity) return { type: 'number', unserializableValue: '-Infinity', description: '-Infinity' }
	if (Object.is(value, -0)) return { type: 'number', unserializableValue: '-0', description: '0' }
	return { type: 'number', value, description: String(value) }
}

function jsonSafeValue(value: unknown): unknown {
	const seen = new WeakSet<object>()
	const convert = (v: unknown): unknown => {
		if (typeof v === 'bigint') return `${v}n`
		if (typeof v === 'symbol' || typeof v === 'function') return undefined
		if (v === null || typeof v !== 'object') return v
		if (seen.has(v)) return '[Circular]'
		seen.add(v)
		if (Array.isArray(v)) return v.map((item) => {
			const converted = convert(item)
			return converted === undefined ? null : converted
		})
		const out: Record<string, unknown> = {}
		for (const key of Object.keys(v)) {
			const converted = convert((v as Record<string, unknown>)[key])
			if (converted !== undefined) out[key] = converted
		}
		return out
	}
	return convert(value)
}

function safeString(v: unknown): string {
	try { return String(v) } catch { return '<unprintable>' }
}

function safeFnString(fn: Function): string {
	try {
		const s = Function.prototype.toString.call(fn)
		return s.length > 200 ? s.slice(0, 200) + '...' : s
	} catch {
		return `function ${fn.name || ''}() { ... }`
	}
}

function compileError(e: unknown): ExceptionDetails {
	const err = e as { message?: string } | undefined
	const message = err?.message ?? String(e)
	// Match common error formats: "at line:col", "SyntaxError at :line:col", "file:line:col"
	const m = message.match(/:(\d+)(?::\d+)?(?:\s|$)/)
	const lineNumber = m ? Number(m[1]) : 0
	return { text: message, exceptionId: 1, lineNumber, columnNumber: 0 }
}
