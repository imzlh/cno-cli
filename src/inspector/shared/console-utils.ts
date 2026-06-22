/**
 * shared/console-utils.ts — helpers for converting raw console method names into
 * CDP wire shapes, shared by the Console domain and the event router.
 *
 * The hooks layer sends raw JS method names (e.g. 'warn', 'group'). The Console
 * domain expects CDP level strings ('warning', 'log'). Runtime.consoleAPICalled
 * expects CDP type strings ('warning', 'startGroup', 'endGroup').
 *
 * Both consumers also need the same stackTrace construction, so we extract that
 * here to keep the two call sites in sync.
 */

import type { ConsoleCallFrame } from './wire'

/** Raw console method  CDP Runtime.consoleAPICalled type. */
export function consoleAPICalledType(method: string): string {
	switch (method) {
		case 'warn':
			return 'warning'
		case 'group':
			return 'startGroup'
		case 'groupEnd':
			return 'endGroup'
		case 'timeEnd':
			return 'timeEnd'
		case 'count':
			return 'count'
		case 'trace':
			return 'trace'
		case 'assert':
			return 'assert'
		case 'table':
			return 'table'
		case 'dir':
			return 'dir'
		case 'error':
			return 'error'
		case 'info':
			return 'info'
		case 'debug':
			return 'debug'
		default:
			return 'log'
	}
}

/** Build a CDP stackTrace from ConsoleCallFrame[]. Shared by console domain and event router. */
export function buildConsoleStackTrace(
	callFrames: ConsoleCallFrame[] | undefined,
): { callFrames: Array<Record<string, unknown>> } | undefined {
	if (!callFrames || callFrames.length === 0) return undefined
	return {
		callFrames: callFrames.map((f) => ({
			functionName: f.functionName,
			scriptId: f.scriptId,
			url: f.url,
			lineNumber: f.lineNumber,
			columnNumber: f.columnNumber,
		})),
	}
}
