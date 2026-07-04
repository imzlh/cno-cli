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
const DEVTOOLS_EVAL_SLOT_PREFIX = '__cnoDevtoolsEvalResult__'
let nextDevtoolsEvalSlot = 0

function isThenable(v: unknown): v is PromiseLike<unknown> {
	return typeof v === 'object' && v !== null && typeof (v as { then?: unknown }).then === 'function'
}

function unwrapEvalResult(v: unknown): unknown {
	if (v && typeof v === 'object' && 'value' in v) return (v as { value: unknown }).value
	return v
}

async function evalWithCapturedCompletion(expression: string, sourceURL = '<devtools>'): Promise<unknown> {
	const slot = `${DEVTOOLS_EVAL_SLOT_PREFIX}${++nextDevtoolsEvalSlot}`
	try {
		try {
			await engine.eval(`${slotRef(slot)} = (${expression})`, sourceURL, engine.EVAL_ASYNC | engine.EVAL_NEW_BACKTRACE)
		} catch (e) {
			if (!isSyntaxLikeError(e)) throw e
			await engine.eval(`${slotRef(slot)} = await (async () => {\n${returnifyLastStatement(expression)}\n})()`, sourceURL, engine.EVAL_ASYNC | engine.EVAL_NEW_BACKTRACE)
		}
		return Reflect.get(globalThis, slot)
	} finally {
		Reflect.deleteProperty(globalThis, slot)
	}
}

function slotRef(slot: string): string {
	return `globalThis[${JSON.stringify(slot)}]`
}

function isSyntaxLikeError(e: unknown): boolean {
	const name = typeof e === 'object' && e !== null ? Reflect.get(e, 'name') : undefined
	const message = e instanceof Error ? e.message : String(e)
	return name === 'SyntaxError'
		|| name === 'TransformError'
		|| /\b(?:SyntaxError|Transform Error|Unexpected|Missing|Invalid|Unterminated)\b/i.test(message)
}

function returnifyLastStatement(source: string): string {
	const trimmed = source.trim()
	if (!trimmed) return ''
	const split = lastTopLevelStatementStart(trimmed)
	const head = trimmed.slice(0, split).trimEnd()
	const tail = trimmed.slice(split).trim().replace(/;+\s*$/, '')
	if (!tail || isStatementOnly(tail)) return trimmed
	return `${head ? `${head}\n` : ''}return (${tail});`
}

function lastTopLevelStatementStart(source: string): number {
	let depth = 0
	let quote: '"' | "'" | '`' | null = null
	let escaped = false
	let last = 0
	for (let i = 0; i < source.length; i++) {
		const ch = source[i]!
		const next = source[i + 1]
		if (quote) {
			if (escaped) { escaped = false; continue }
			if (ch === '\\') { escaped = true; continue }
			if (quote !== '`' && ch === quote) { quote = null; continue }
			if (quote === '`' && ch === '`') { quote = null; continue }
			continue
		}
		if (ch === '/' && next === '/') {
			while (i < source.length && source[i] !== '\n') i++
			continue
		}
		if (ch === '/' && next === '*') {
			i += 2
			while (i < source.length && !(source[i] === '*' && source[i + 1] === '/')) i++
			i++
			continue
		}
		if (ch === '"' || ch === "'" || ch === '`') { quote = ch; continue }
		if (ch === '(' || ch === '[' || ch === '{') depth++
		else if (ch === ')' || ch === ']' || ch === '}') depth = Math.max(0, depth - 1)
		else if (ch === ';' && depth === 0) last = i + 1
		else if ((ch === '\n' || ch === '\r') && depth === 0) {
			const nextStart = nextTopLevelStatementStart(source, i + 1)
			if (nextStart > 0 && canSplitTopLevelStatement(source, i, nextStart)) last = nextStart
		}
	}
	return last
}

function nextTopLevelStatementStart(source: string, index: number): number {
	let i = index
	while (i < source.length) {
		const ch = source[i]!
		if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r') {
			i++
			continue
		}
		if (ch === '/' && source[i + 1] === '/') {
			i += 2
			while (i < source.length && source[i] !== '\n' && source[i] !== '\r') i++
			continue
		}
		if (ch === '/' && source[i + 1] === '*') {
			i += 2
			while (i < source.length && !(source[i] === '*' && source[i + 1] === '/')) i++
			i = Math.min(source.length, i + 2)
			continue
		}
		return i
	}
	return -1
}

function canSplitTopLevelStatement(source: string, newlineIndex: number, nextStart: number): boolean {
	const prev = previousSignificantChar(source, newlineIndex)
	const next = source[nextStart]
	if (!prev || !next) return false
	if (isLineContinuationPrefix(next)) return false
	if (isLineContinuationSuffix(prev)) return false
	return true
}

function previousSignificantChar(source: string, index: number): string | null {
	for (let i = index; i >= 0; i--) {
		const ch = source[i]!
		if (ch !== ' ' && ch !== '\t' && ch !== '\n' && ch !== '\r') return ch
	}
	return null
}

function isLineContinuationPrefix(ch: string): boolean {
	return ch === '.' || ch === ',' || ch === ':' || ch === ';' || ch === ')' || ch === ']' || ch === '}' || ch === '?'
}

function isLineContinuationSuffix(ch: string): boolean {
	return ch === '.' || ch === ',' || ch === ':' || ch === '?' || ch === '+' || ch === '-' || ch === '*' || ch === '/'
		|| ch === '%' || ch === '&' || ch === '|' || ch === '^' || ch === '=' || ch === '<' || ch === '>' || ch === '('
		|| ch === '[' || ch === '{' || ch === '!'
}

function isStatementOnly(source: string): boolean {
	return /^(?:var|let|const|function|class|if|for|while|do|switch|try|throw|return|break|continue|import|export)\b/.test(source)
}

/** Build a returnByValue RemoteObject (value embedded, no objectId). */
function byValue(val: unknown): RemoteObject {
	if (typeof val === 'undefined') return { type: 'undefined' }
	if (typeof val === 'string') return { type: 'string', value: val }
	if (typeof val === 'boolean') return { type: 'boolean', value: val }
	if (typeof val === 'number') return serializeNumber(val)
	if (typeof val === 'bigint') return { type: 'bigint', unserializableValue: `${val}n`, description: `${val}n` }
	if (typeof val === 'symbol') return { type: 'symbol', description: safeString(val) }
	if (typeof val === 'function') return { type: 'function', description: safeFnString(val as Function) }
	const t = typeof val
	const type: RemoteObjectType = val === null ? 'object' : (t as RemoteObjectType)
	return { type, value: jsonSafeValue(val) }
}

/** Base frame offset — the number of JS frames between the onBreak call site
 *  (buildCallFrame) and the user's code. */
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
				val = await evalWithCapturedCompletion(q.expression)
				if (q.awaitPromise && isThenable(val)) val = await val
			}
			if (q.returnByValue) return { result: byValue(val) }
			return { result: this.serializer.serialize(val, group, { preview: !!q.generatePreview }) }
		} catch (e) {
			return this.errorResult(e)
		}
	}

	async callFunctionOn(q: RpcParams['callFunctionOn']): Promise<EvaluateResponse> {
		const group = q.objectGroup ?? this.groupFromObject(q.objectId) ?? 'runtime'
		try {
			const target = q.objectId ? this.serializer.resolve(q.objectId) : undefined
			const args = (q.arguments ?? []).map((a) => this.resolveArgument(a))
			const fn = await evalWithCapturedCompletion(`(${q.functionDeclaration})`)
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
		const group = q.objectGroup ?? this.groupFromObject(q.objectId) ?? 'runtime'
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
		const group = q.objectGroup ?? this.groupFromObject(q.promiseObjectId) ?? 'runtime'
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

	private groupFromObject(objectId?: string): string | undefined {
		return objectId ? this.serializer.groupOf(objectId) : undefined
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
		const thrown = e instanceof Error ? e : new Error(String(e))
		const message = thrown.message || String(e)
		const exception = this.serializer.serialize(thrown, 'runtime', { preview: true })
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
