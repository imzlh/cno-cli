/**
 * main/evaluator.ts — expression evaluation and script compilation.
 *
 * Owns the engine-facing side of Runtime.evaluate / Debugger.evaluateOnCallFrame
 * / Runtime.callFunctionOn / compileScript / runScript. While paused it uses
 * the native in-frame evaluator; while running it uses the async engine eval.
 * Results are turned into RemoteObjects by the shared Serializer.
 */

import { FrameOffset, native } from '../shared/native'
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

type InspectorCallable = ((...args: unknown[]) => unknown) & { name?: string }
type InspectableFunction = object & { name?: string }

const engine = import.meta.use('engine')
const nativeConsole = import.meta.use('console')
const DEVTOOLS_EVAL_SLOT_PREFIX = '__cnoDevtoolsEvalResult__'
/** Property name of the in-VM completion-value box. See `Captured`. */
const CAPTURE_KEY = '__cnoCapturedCompletion__'
let nextDevtoolsEvalSlot = 0
let nextCompiledScriptId = 0

function isThenable(v: unknown): v is PromiseLike<unknown> {
	return typeof v === 'object' && v !== null && typeof Reflect.get(v, 'then') === 'function'
}

function unwrapEvalResult(v: unknown): unknown {
	if (v && typeof v === 'object' && 'value' in v) return Reflect.get(v, 'value')
	return v
}

/**
 * The completion value, boxed.
 *
 * The box is load-bearing, not decoration. `evalWithCapturedCompletion` is an
 * `async function`, and an async function's return value is ALWAYS adopted: a
 * returned thenable is resolved before the caller's `await` sees it. Returning
 * the bare completion value therefore made `Runtime.evaluate` resolve every
 * Promise regardless of `awaitPromise`, because the value had already been
 * unwrapped by the time `q.awaitPromise` was consulted.
 *
 * MEASURED, cno before this change: evaluate `new Promise(r=>setTimeout(()=>r(99),200))`
 * with `awaitPromise:false` -> {"type":"number","value":99}.
 * MEASURED, node v24.18.0, same expression and flag ->
 * {"type":"object","subtype":"promise","className":"Promise",objectId:...}.
 * The slot itself always held the real Promise (measured: `slotIsThenable=true`),
 * so the loss happened purely at the async-return boundary.
 */
type Captured = { readonly v: unknown }

async function evalWithCapturedCompletion(expression: string, sourceURL = '<devtools>'): Promise<Captured> {
	const slot = `${DEVTOOLS_EVAL_SLOT_PREFIX}${++nextDevtoolsEvalSlot}`
	try {
		try {
			await engine.eval(`${slotRef(slot)} = (${expression})`, sourceURL, engine.EVAL_ASYNC | engine.EVAL_NEW_BACKTRACE)
		} catch (e) {
			if (!isSyntaxLikeError(e)) throw e
			// The fallback IIFE is async so the body may use top-level await. That
			// makes its return value adopted too, so the box has to be built INSIDE
			// the IIFE — `await (async()=>{...})()` on a Promise-valued body would
			// otherwise resolve it here, before awaitPromise is consulted.
			await engine.eval(`${slotRef(slot)} = await (async () => {\n${returnifyLastStatement(expression, true)}\n})()`, sourceURL, engine.EVAL_ASYNC | engine.EVAL_NEW_BACKTRACE)
			return { v: unboxCaptured(Reflect.get(globalThis, slot)) }
		}
		return { v: Reflect.get(globalThis, slot) }
	} finally {
		Reflect.deleteProperty(globalThis, slot)
	}
}

/**
 * Unwrap the in-VM box produced by `returnifyLastStatement(_, true)`.
 *
 * A statement-only body (`var q=1;`) gets no `return`, so the IIFE yields
 * undefined rather than a box; that is not an error, it is `undefined` as the
 * completion value, which is what node reports for the same input.
 */
function unboxCaptured(boxed: unknown): unknown {
	if (boxed && typeof boxed === 'object' && CAPTURE_KEY in boxed) return Reflect.get(boxed, CAPTURE_KEY)
	return undefined
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

/**
 * Turn the last top-level statement into a `return`, so the IIFE fallback has a
 * completion value.
 *
 * `box` wraps that value in `{[CAPTURE_KEY]: ...}` inside the VM. It must be
 * applied in-VM because the IIFE is async: a bare `return somePromise` would be
 * adopted by the IIFE's own promise and resolved before the caller could honour
 * `awaitPromise:false`.
 */
function returnifyLastStatement(source: string, box = false): string {
	const trimmed = source.trim()
	if (!trimmed) return ''
	const split = lastTopLevelStatementStart(trimmed)
	const head = trimmed.slice(0, split).trimEnd()
	const tail = trimmed.slice(split).trim().replace(/;+\s*$/, '')
	if (!tail || isStatementOnly(tail)) return trimmed
	const returned = box ? `{${JSON.stringify(CAPTURE_KEY)}: (${tail})}` : `(${tail})`
	return `${head ? `${head}\n` : ''}return ${returned};`
}

function lastTopLevelStatementStart(source: string): number {
	let depth = 0
	let quote: '"' | "'" | '`' | null = null
	let escaped = false
	let last = 0
	for (let i = 0; i < source.length; i++) {
		const ch = source[i]
		if (ch === undefined) continue
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
		const ch = source[i]
		if (ch === undefined) break
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
		const ch = source[i]
		if (ch === undefined) continue
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
	if (typeof val === 'function') return { type: 'function', description: safeFnString(val) }
	const t = typeof val
	const type: RemoteObjectType = val === null ? 'object' : (t as RemoteObjectType)
	return { type, value: jsonSafeValue(val) }
}

export class Evaluator {
	private readonly compiledScripts = new Map<string, { mod: CModuleEngine.Module; persist: boolean }>()
	/**
	 * Cap on retained compiled scripts. CDP has no `Runtime.releaseScript`, and
	 * DevTools calls `Runtime.compileScript` with `persistScript: true` for watch
	 * expressions and autocomplete probes, so nothing ever removes a persisted
	 * entry — each one pinning a compiled engine.Module. Without a bound a long
	 * session grows this map forever. Same leak shape as fetch.ts MAX_CACHED_BODIES.
	 */
	private static readonly MAX_COMPILED_SCRIPTS = 256

	constructor(private readonly serializer: Serializer) {}

	/** Synchronous evaluate — for use while paused (dispatchSync rejects Promises). */
	evaluateSync(q: RpcParams['evaluate']): EvaluateResponse {
		const group = q.objectGroup ?? 'backtrace'
		try {
			if (containsAwait(q.expression)) {
				return this.errorResult(new Error('Cannot evaluate `await` expression while paused'))
			}
			const level = Number(q.callFrameId ?? 0) || 0
			// FrameOffset.PausedEval: service loop + evaluateSync (see shared/native).
			const val = native.evalInFrame(level + FrameOffset.PausedEval, q.expression)
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
				val = native.evalInFrame(level + FrameOffset.PausedEval, q.expression)
			} else {
				val = (await evalWithCapturedCompletion(q.expression)).v
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
			const target = this.resolveReceiver(q.objectId)
			const args = (q.arguments ?? []).map((a) => this.resolveArgument(a))
			const fn = (await evalWithCapturedCompletion(`(${q.functionDeclaration})`)).v
			if (typeof fn !== 'function') throw new TypeError('callFunctionOn: declaration is not a function')
			let val: unknown = Reflect.apply(fn as InspectorCallable, target, args)
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
			const target = this.resolveReceiver(q.objectId)
			const args = (q.arguments ?? []).map((a) => this.resolveArgument(a))
			const factory = engine.eval<unknown>(`(${q.functionDeclaration})`, '<devtools>', engine.EVAL_NEW_BACKTRACE)
			const fn = unwrapEvalResult(factory)
			if (typeof fn !== 'function') throw new TypeError('callFunctionOn: declaration is not a function')
			let val: unknown = Reflect.apply(fn as InspectorCallable, target, args)
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

	/**
	 * Resolve the `this` receiver for callFunctionOn, rejecting a stale handle.
	 *
	 * A released or unknown objectId used to resolve to `undefined`, so the function
	 * silently ran with `this === undefined` against the wrong receiver instead of
	 * reporting failure — a DevTools getter probe or "Store as global variable" on a
	 * handle whose group was already released would quietly do the wrong thing.
	 * `has()` distinguishes "not in the store" from "stored value IS undefined".
	 * MEASURED, node v24.18: callFunctionOn with a released objectId answers
	 * {"code":-32000,"message":"Could not find object with given id"}.
	 */
	private resolveReceiver(objectId?: string): unknown {
		if (!objectId) return undefined
		if (!this.serializer.has(objectId)) {
			throw new Error('Could not find object with given id')
		}
		return this.serializer.resolve(objectId)
	}

	compileScript(q: RpcParams['compileScript']): CompileScriptResponse {
		const sourceURL = q.sourceURL || '<compiled>'
		try {
			// The completion value must be reachable after eval(); a bare
			// expression statement leaves `namespace.default` undefined, so
			// runScript would always report `undefined`.
			//
			// KNOWN GAP: CDP's `expression` is a script body, not strictly an
			// expression, so a statement compiles here into
			// `export default (var q=1;)` and fails. MEASURED: node v24.18 compiles
			// `var q=1;` successfully and returns a scriptId. The failure is at least
			// clean — it lands in the catch below as exceptionDetails rather than
			// escaping the RPC layer — but DevTools' own console never takes this path
			// (it uses Runtime.evaluate), so the wrapper is kept for the completion
			// value it buys.
			const mod = new engine.Module(`export default (${q.expression})`, sourceURL)
			// sourceURL is caller-controlled and often reused — never key on it.
			const scriptId = `script:${++nextCompiledScriptId}`
			// Evict oldest-first once at the cap. A displaced scriptId then answers
			// "unknown scriptId" from runScript, which is the same error DevTools
			// already handles for a stale id (MEASURED, node v24.18: a second run of
			// any compiled script answers -32000 "No script with given id").
			if (this.compiledScripts.size >= Evaluator.MAX_COMPILED_SCRIPTS) {
				const oldest = this.compiledScripts.keys().next().value
				if (oldest !== undefined) this.compiledScripts.delete(oldest)
			}
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
			// NOT bracketed with ModuleCompiler.evalTracked, unlike the CLI entry-eval
			// sites (src/commands/run.ts, src/commands/eval.ts). Deliberate: this mod
			// comes from a raw `new engine.Module` in compileScript, so it is not in
			// esmCache and no require() can resolve to it — nothing can re-enter it
			// mid-evaluation, which is the precondition for the JS_MODULE_STATUS_EVALUATING
			// abort. The Evaluator also holds no compiler reference to bracket with.
			// A repeat runScript on a persisted script re-evals an EVALUATED module,
			// and that status IS in js_link_module's allow-list (quickjs.c:32089).
			await entry.mod.eval()
			let val = entry.mod.namespace.default
			// runScript honours awaitPromise exactly as evaluate does. Without this a
			// promise-valued script answered the Promise itself, which under
			// returnByValue serialises to `{}` — a silently wrong result rather than
			// an error. MEASURED, cno before this change: compileScript
			// `import("node:os").then(m=>typeof m.platform)` + runScript
			// {awaitPromise:true,returnByValue:true} -> value {}. MEASURED, node
			// v24.18.0, same sequence -> value "function".
			if (q.awaitPromise && isThenable(val)) val = await val
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

	/** Retained compiled-script count. For tests asserting the table stays bounded. */
	compiledScriptCount(): number {
		return this.compiledScripts.size
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
			try { nativeConsole.warn(`unknown unserializableValue: ${u}`) } catch { /* ignore */ }
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
	// Path-scoped, not visit-scoped: a value reachable twice via different
	// branches is shared, not circular, and JSON.stringify duplicates it.
	const path = new WeakSet<object>()
	const convert = (v: unknown): unknown => {
		if (typeof v === 'bigint') return `${v}n`
		if (typeof v === 'symbol' || typeof v === 'function') return undefined
		if (v === null || typeof v !== 'object') return v
		if (path.has(v)) return '[Circular]'
		path.add(v)
		try {
			if (Array.isArray(v)) {
				return v.map((item) => {
					const converted = convert(item)
					return converted === undefined ? null : converted
				})
			}
			const out: Record<string, unknown> = {}
			for (const key of Object.keys(v)) {
				const converted = convert(Reflect.get(v, key))
				if (converted !== undefined) out[key] = converted
			}
			return out
		} finally {
			path.delete(v)
		}
	}
	return convert(value)
}

function safeString(v: unknown): string {
	try {
		return String(v)
	} catch {
		return '<unprintable>'
	}
}

function safeFnString(fn: InspectableFunction): string {
	try {
		const s = Function.prototype.toString.call(fn)
		return s.length > 200 ? s.slice(0, 200) + '...' : s
	} catch {
		return `function ${fn.name || ''}() { ... }`
	}
}

function compileError(e: unknown): ExceptionDetails {
	const rawMessage = e && (typeof e === 'object' || typeof e === 'function') ? Reflect.get(e, 'message') : undefined
	const message = typeof rawMessage === 'string' ? rawMessage : String(e)
	// Match common error formats: "at line:col", "SyntaxError at :line:col", "file:line:col"
	const m = message.match(/:(\d+)(?::\d+)?(?:\s|$)/)
	const lineNumber = m ? Number(m[1]) : 0
	return { text: message, exceptionId: 1, lineNumber, columnNumber: 0 }
}
