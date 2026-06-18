/**
 * domains/side-effect.ts — conservative side-effect analysis for console eval.
 *
 * DevTools previews expressions as you type (`throwOnSideEffect`). Every
 * function call and `new` expression is blocked unless the callee/constructor
 * is on the explicit allowlist below. Everything else (assignment, ++/--, delete,
 * throw, yield) is always blocked.
 */

import { parse } from '../../../cts/deps/sucrase/src/parser/index'
import { TokenType } from '../../../cts/deps/sucrase/src/parser/tokenizer/types'
import { ContextualKeyword } from '../../../cts/deps/sucrase/src/parser/tokenizer/keywords'

type Token = ReturnType<typeof parse>['tokens'][number]

function tokenText(src: string, tok: Token): string {
	return src.slice(tok.start, tok.end)
}

/** Walk forward from a `_new` token to collect the dotted constructor name. */
function extractNewTarget(tokens: Token[], src: string, newIdx: number): string {
	const parts: string[] = []
	let i = newIdx + 1
	while (i < tokens.length && tokens[i].isType) i++
	let phase: 'name' | 'dot' = 'name'
	while (i < tokens.length) {
		const tok = tokens[i]
		if (tok.isType) { i++; continue }
		if (phase === 'name' && tok.type === TokenType.name) {
			parts.push(tokenText(src, tok)); phase = 'dot'; i++
		} else if (phase === 'dot' && tok.type === TokenType.dot) {
			phase = 'name'; i++
		} else {
			break
		}
	}
	return parts.join('.')
}

/** Walk backward from a `parenL` index to collect the dotted callee name. */
function extractCallee(tokens: Token[], src: string, parenLIdx: number): string {
	const parts: string[] = []
	let j = parenLIdx - 1
	while (j >= 0 && tokens[j].isType) j--
	let phase: 'name' | 'dot' = 'name'
	while (j >= 0) {
		while (j >= 0 && tokens[j].isType) j--
		if (j < 0) break
		const tok = tokens[j]
		if (phase === 'name' && tok.type === TokenType.name) {
			parts.unshift(tokenText(src, tok)); phase = 'dot'; j--
		} else if (phase === 'dot' && tok.type === TokenType.dot) {
			phase = 'name'; j--
		} else {
			break
		}
	}
	return parts.join('.')
}

/** Constructors that do not cause observable side effects. */
const PURE_CONSTRUCTORS = new Set([
	'URL', 'URLSearchParams',
	'Date', 'RegExp',
	'Error', 'TypeError', 'RangeError', 'ReferenceError', 'SyntaxError', 'URIError', 'EvalError',
	'Map', 'Set', 'WeakMap', 'WeakSet', 'WeakRef',
	'Int8Array', 'Uint8Array', 'Uint8ClampedArray', 'Int16Array', 'Uint16Array',
	'Int32Array', 'Uint32Array', 'Float32Array', 'Float64Array',
	'BigInt64Array', 'BigUint64Array',
	'ArrayBuffer', 'SharedArrayBuffer', 'DataView',
	'TextEncoder', 'TextDecoder',
	'Headers', 'FormData', 'Blob',
	'Object', 'Array', 'String', 'Number', 'Boolean', 'Symbol', 'BigInt',
	'Promise',
])

/** Free functions and static methods that do not cause observable side effects. */
const PURE_CALLEES = new Set([
	// Global coercions / conversions
	'String', 'Number', 'Boolean', 'BigInt', 'Symbol',
	'parseInt', 'parseFloat', 'isNaN', 'isFinite',
	'encodeURIComponent', 'decodeURIComponent', 'encodeURI', 'decodeURI',
	'atob', 'btoa', 'structuredClone',
	// JSON
	'JSON.parse', 'JSON.stringify',
	// Math
	'Math.abs', 'Math.ceil', 'Math.floor', 'Math.round', 'Math.trunc', 'Math.sign',
	'Math.max', 'Math.min', 'Math.pow', 'Math.sqrt', 'Math.cbrt', 'Math.hypot',
	'Math.log', 'Math.log2', 'Math.log10', 'Math.exp', 'Math.expm1', 'Math.log1p',
	'Math.sin', 'Math.cos', 'Math.tan', 'Math.asin', 'Math.acos', 'Math.atan', 'Math.atan2',
	'Math.sinh', 'Math.cosh', 'Math.tanh', 'Math.asinh', 'Math.acosh', 'Math.atanh',
	'Math.random', 'Math.fround', 'Math.clz32', 'Math.imul',
	// Object
	'Object.keys', 'Object.values', 'Object.entries', 'Object.fromEntries',
	'Object.assign', 'Object.create', 'Object.freeze', 'Object.seal',
	'Object.isFrozen', 'Object.isSealed', 'Object.is', 'Object.hasOwn',
	'Object.getPrototypeOf', 'Object.getOwnPropertyNames',
	'Object.getOwnPropertyDescriptor', 'Object.getOwnPropertyDescriptors',
	'Object.getOwnPropertySymbols',
	// Array
	'Array.from', 'Array.isArray', 'Array.of',
	// String
	'String.fromCharCode', 'String.fromCodePoint', 'String.raw',
	// Number
	'Number.isNaN', 'Number.isFinite', 'Number.isInteger', 'Number.isSafeInteger',
	'Number.parseInt', 'Number.parseFloat',
	// Date
	'Date.now', 'Date.parse', 'Date.UTC',
	// Promise
	'Promise.resolve', 'Promise.reject', 'Promise.all', 'Promise.allSettled',
	'Promise.any', 'Promise.race',
])

const CALL_CALLEE = new Set<number>([
	TokenType.name,
	TokenType.parenR,
	TokenType.bracketR,
	TokenType.nonNullAssertion,
])

/** Scan a JS expression for a top-level `await` keyword (not inside a nested function). */
export function containsAwait(expr: string): boolean {
	try {
		const tokens = parse(`(${expr})`, false, false, false).tokens
		for (const tok of tokens) {
			if (tok.contextualKeyword === ContextualKeyword._await && tok.identifierRole == null) {
				return true
			}
		}
	} catch { /* syntax error → no await */ }
	return false
}

export function isSideEffectFree(expr: string): boolean {
	let tokens
	try {
		tokens = parse(`(${expr})`, false, false, false).tokens
	} catch {
		return false
	}
	const src = `(${expr})`

	for (let i = 0; i < tokens.length; i++) {
		const tok = tokens[i]
		if (tok.isType) continue
		const type = tok.type

		if (
			type === TokenType._delete ||
			type === TokenType._throw ||
			type === TokenType._yield
		) return false
		if ((type & TokenType.IS_ASSIGN) !== 0) return false
		if (type === TokenType.preIncDec || type === TokenType.postIncDec) return false

		if (type === TokenType._new) {
			const ctor = extractNewTarget(tokens, src, i)
			if (!ctor || !PURE_CONSTRUCTORS.has(ctor)) return false
			continue
		}

		if (type === TokenType.parenL) {
			let j = i - 1
			while (j >= 0 && tokens[j].isType) j--
			if (j < 0) continue
			const prev = tokens[j]
			if (prev.type === TokenType.questionDot) return false
			if (CALL_CALLEE.has(prev.type)) {
				if (prev.type === TokenType.name) {
					// If the token directly before the constructor name is `_new`,
					// this parenL belongs to a new-expression already vetted above.
					let k = j - 1
					while (k >= 0 && tokens[k].isType) k--
					if (k >= 0 && tokens[k].type === TokenType._new) continue
				}
				const callee = extractCallee(tokens, src, i)
				if (!callee || !PURE_CALLEES.has(callee)) return false
			}
		}
	}
	return true
}
