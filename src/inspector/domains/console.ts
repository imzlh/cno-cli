/**
 * domains/console.ts — Console CDP domain (worker thread).
 *
 * Buffers console messages (bounded) so a late-connecting DevTools still sees
 * earlier output, then replays them on Console.enable. Console args arrive as
 * already-serialized RemoteObjects from the main thread.
 */

import { Domain } from './base'
import type { CDPDispatcher, EmitEvent } from '../worker/dispatcher'
import type { RemoteObject } from '../shared/cdp'
import type { ConsoleCallFrame } from '../shared/wire'
import { buildConsoleStackTrace } from '../shared/console-utils'
import { getMemoryTier } from '../../../cno/src/utils/memory-tier'

const CDP_LEVEL: Record<string, string> = {
	log: 'log', info: 'info', debug: 'debug', warn: 'warning', warning: 'warning',
	error: 'error', dir: 'log', table: 'log', trace: 'log',
	group: 'log', groupEnd: 'log', assert: 'error', count: 'log',
	countReset: 'log', time: 'log', timeEnd: 'log', timeLog: 'log',
}

const MAX_BACKLOG = { low: 100, normal: 300, high: 500 }[getMemoryTier()] ?? 300

interface ConsoleEntry {
	method: string
	args: RemoteObject[]
	timestamp: number
	callFrames?: ConsoleCallFrame[]
}

export class ConsoleDomain extends Domain {
	private enabled = false
	private backlog: ConsoleEntry[] = []

	constructor(dispatcher: CDPDispatcher, event: EmitEvent) {
		super(dispatcher, event)
		this.on('Console.enable', () => {
			this.enabled = true
			// Replay backlog then clear it — avoids duplicates on reconnect.
			for (const entry of this.backlog) this.emitMessage(entry.method, entry.args, entry.timestamp, entry.callFrames)
			this.backlog.length = 0
			return {}
		})
		this.on('Console.disable', () => {
			this.enabled = false
			return {}
		})
		this.on('Console.clearMessages', () => {
			this.backlog.length = 0
			return {}
		})
	}

	onConsole(method: string, args: RemoteObject[], timestamp: number, callFrames?: ConsoleCallFrame[]): void {
		if (this.backlog.length >= MAX_BACKLOG) this.backlog.shift()
		this.backlog.push({ method, args, timestamp, callFrames })
		if (this.enabled) this.emitMessage(method, args, timestamp, callFrames)
	}

	private emitMessage(method: string, args: RemoteObject[], timestamp: number, callFrames?: ConsoleCallFrame[]): void {
		const level = CDP_LEVEL[method] ?? 'log'

		// The deprecated Console domain still drives the right-side location
		// anchor in some DevTools paths, so keep the top frame flattened too.
		const topFrame = callFrames?.[0]
		const url = topFrame?.url ?? ''

		// Build CDP stackTrace (Console domain expects CallFrame[])
		const stackTrace = buildConsoleStackTrace(callFrames)

		this.event('Console.messageAdded', {
			message: {
				source: 'console-api',
				level,
				text: argsToText(args),
				timestamp,
				url,
				line: topFrame ? topFrame.lineNumber + 1 : undefined,
				column: topFrame ? topFrame.columnNumber + 1 : undefined,
				executionContextId: 1,
				parameters: args,
				stackTrace,
			},
		})
	}
}

function argsToText(args: RemoteObject[]): string {
	return args
		.map((a) => {
			if (a == null) return String(a)
			if (a.value !== undefined) return String(a.value)
			if (a.unserializableValue) return a.unserializableValue
			if (a.description) return a.description
			return '[object]'
		})
		.join(' ')
}
