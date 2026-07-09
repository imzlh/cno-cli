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

export interface SourceMapMappingResult {
	found?: boolean
	original_file?: string
	original_line?: number
	original_column?: number
}

export interface SourceMapLookup {
	getMapping(filePath: string, line: number, column: number): SourceMapMappingResult
}

export interface RemappedFrame {
	filePath: string
	lineNumber: number
	columnNumber: number
	found: boolean
}

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

/**
 * Map a raw native console frame into CDP coordinates.
 *
 * QuickJS frame lines are 1-based; CDP expects 0-based lines/columns. The
 * sourcemap module also expects the generated line in QuickJS coordinates and
 * returns the original column already 0-based.
 */
export function remapConsoleFrame(
	filePath: string,
	line: number,
	column: number,
	sourcemap?: SourceMapLookup,
	zeroBasedInput = false,
): { filePath: string; lineNumber: number; columnNumber: number } {
	const remapped = remapConsoleFrameDetailed(filePath, line, column, sourcemap, zeroBasedInput)
	return {
		filePath: remapped.filePath,
		lineNumber: remapped.lineNumber,
		columnNumber: remapped.columnNumber,
	}
}

export function remapConsoleFrameDetailed(
	filePath: string,
	line: number,
	column: number,
	sourcemap?: SourceMapLookup,
	zeroBasedInput = false,
): RemappedFrame {
	const generatedLine = zeroBasedInput ? line + 1 : line
	const generatedColumn = zeroBasedInput ? column : column
	let nextFile = filePath
	let nextLine = zeroBasedInput ? line : line - 1
	let nextColumn = zeroBasedInput ? column : column - 1
	let found = false

	if (!sourcemap || !filePath || generatedLine <= 0 || generatedColumn < 0) {
		return { filePath: nextFile, lineNumber: nextLine, columnNumber: nextColumn, found }
	}

	try {
		for (const candidate of sourceMapLookupCandidates(filePath)) {
			const mapped = sourcemap.getMapping(candidate, generatedLine, generatedColumn)
			if (mapped.found && typeof mapped.original_line === 'number') {
				found = true
				if (typeof mapped.original_file === 'string' && mapped.original_file) {
					nextFile = mapped.original_file
				}
				nextLine = mapped.original_line - 1
				if (typeof mapped.original_column === 'number' && Number.isFinite(mapped.original_column)) {
					nextColumn = mapped.original_column
				}
				break
			}
		}
	} catch {
		/* ignore sourcemap lookup failures */
	}

	return { filePath: nextFile, lineNumber: nextLine, columnNumber: nextColumn, found }
}

function sourceMapLookupCandidates(filePath: string): string[] {
	const out = new Set<string>()
	out.add(filePath)

	const normalized = filePath.replace(/\\/g, '/')
	out.add(normalized)

	if (normalized.startsWith('file:///')) {
		out.add(normalized.slice('file:///'.length - 1))
		out.add(normalized.slice('file:///'.length))
	} else if (normalized.startsWith('/')) {
		out.add(`file://${normalized}`)
		out.add(`file:///${normalized.slice(1)}`)
	}

	return [...out]
}
