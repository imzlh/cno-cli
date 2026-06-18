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

const CDP_LEVEL: Record<string, string> = {
	log: 'log', info: 'info', debug: 'debug', warn: 'warning',
	error: 'error', dir: 'log', table: 'log', trace: 'trace',
	group: 'log', groupEnd: 'log', assert: 'error', count: 'log',
	countReset: 'log', time: 'log', timeEnd: 'log', timeLog: 'log',
}

const MAX_BACKLOG = 500

interface ConsoleEntry {
	method: string
	args: RemoteObject[]
	timestamp: number
}

export class ConsoleDomain extends Domain {
	private enabled = false
	private backlog: ConsoleEntry[] = []

	constructor(dispatcher: CDPDispatcher, event: EmitEvent) {
		super(dispatcher, event)
		this.on('Console.enable', () => {
			this.enabled = true
			// Replay backlog then clear it — avoids duplicates on reconnect.
			for (const entry of this.backlog) this.emitMessage(entry.method, entry.args, entry.timestamp)
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

	onConsole(method: string, args: RemoteObject[]): void {
		const timestamp = Date.now() / 1000
		if (this.backlog.length >= MAX_BACKLOG) this.backlog.shift()
		this.backlog.push({ method, args, timestamp })
		if (this.enabled) this.emitMessage(method, args, timestamp)
	}

	private emitMessage(method: string, args: RemoteObject[], timestamp: number): void {
		const level = CDP_LEVEL[method] ?? 'log'
		this.event('Console.messageAdded', {
			message: {
				source: 'javascript',
				level,
				text: argsToText(args),
				timestamp,
				url: '',
				executionContextId: 1,
				parameters: args,
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
