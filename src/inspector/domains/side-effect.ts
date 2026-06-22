/**
 * domains/side-effect.ts — side-effect analysis for console eval preview.
 *
 * DevTools previews expressions as you type (`throwOnSideEffect`). Uses a
 * **blocklist** strategy: only known-dangerous operations are rejected.
 *
 * Always rejected (state mutation / control flow):
 *   - assignment operators, ++/--, delete, throw, yield
 *   - optional-chaining calls  ?.()
 *   - import()
 *
 * Rejected by name (known-dangerous callees / constructors):
 *   - eval, Function, setTimeout, setInterval, setImmediate, queueMicrotask, require
 *   - new Worker / SharedWorker / Function
 *
 * Everything else — including console.log, instance methods, unknown
 * constructors — is allowed so the preview is maximally useful.
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

/** Constructors known to cause observable side effects (threads, dynamic code). */
const DANGEROUS_CONSTRUCTORS = new Set([
	'Function',
	'Worker', 'SharedWorker', 'ServiceWorker',
])

/** Free functions / static methods known to cause side effects or schedule code. */
const DANGEROUS_CALLEES = new Set([
	'eval',
	'Function',
	'setTimeout', 'setInterval', 'setImmediate', 'queueMicrotask',
	'require',
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
	let tokens: ReturnType<typeof parse>['tokens']
	let src: string
	let programMode = false

	try {
		src = `(${expr})`
		tokens = parse(src, false, false, false).tokens
	} catch {
		// Expression parse failed — try as program (multi-statement code).
		// This handles pasted code like `const x = 1; console.log(x)`.
		try {
			src = expr
			tokens = parse(src, false, false, false).tokens
			programMode = true
		} catch {
			return false
		}
	}

	// In program mode, `=` in declarations (`const x = 1`) is NOT a mutation.
	// Track declaration state to skip the first `=` after const/let/var.
	let inDecl = false

	for (let i = 0; i < tokens.length; i++) {
		const tok = tokens[i]
		if (tok.isType) continue
		const type = tok.type

		// Hard-blocked: state mutation / control flow keywords
		if (
			type === TokenType._delete ||
			type === TokenType._throw ||
			type === TokenType._yield
		) return false
		if (type === TokenType.preIncDec || type === TokenType.postIncDec) return false

		// Assignment operators: in program mode, skip the `=` that belongs
		// to a variable declaration (const/let/var ... = expr).
		if ((type & TokenType.IS_ASSIGN) !== 0) {
			if (programMode && inDecl) {
				inDecl = false // only skip the declaration's own `=`
				continue
			}
			return false
		}

		// Track variable declarations (program mode only)
		if (programMode) {
			if (type === TokenType._const || type === TokenType._let || type === TokenType._var) {
				inDecl = true
			} else if (type === TokenType.semi || type === TokenType.braceR) {
				inDecl = false
			}
		}

		// import — both dynamic import() and static import statements are side effects
		if (type === TokenType._import) return false

		// new-expression: block only known-dangerous constructors
		if (type === TokenType._new) {
			const ctor = extractNewTarget(tokens, src, i)
			if (DANGEROUS_CONSTRUCTORS.has(ctor)) return false
			continue
		}

		// Function call: block only known-dangerous callees
		if (type === TokenType.parenL) {
			let j = i - 1
			while (j >= 0 && tokens[j].isType) j--
			if (j < 0) continue
			const prev = tokens[j]
			// Optional chaining call ?.() — reject (uncertain null-side-effects)
			if (prev.type === TokenType.questionDot) return false
			if (CALL_CALLEE.has(prev.type)) {
				if (prev.type === TokenType.name) {
					// If the token before the name is `new`, this parenL belongs
					// to a new-expression already vetted above — skip.
					let k = j - 1
					while (k >= 0 && tokens[k].isType) k--
					if (k >= 0 && tokens[k].type === TokenType._new) continue
				}
				const callee = extractCallee(tokens, src, i)
				if (callee && DANGEROUS_CALLEES.has(callee)) return false
			}
		}
	}
	return true
}
