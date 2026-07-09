import { ok, strictEqual } from 'node:assert'
import { Hooks } from '../../src/inspector/main/hooks.ts'
import type { ConsolePayload } from '../../src/inspector/shared/wire.ts'

function parseTopUserFrame(stack: string): { functionName: string; filePath: string; line: number } {
	for (const line of stack.split('\n').slice(1)) {
		const match = line.match(/^\s*at\s+(.+?)\s+\((.+):(\d+):(\d+)\)\s*$/) ??
			line.match(/^\s*at\s+(.+):(\d+):(\d+)\s*$/)
		if (!match) continue
		if (match.length === 5) {
			const filePath = match[2] ?? ''
			if (filePath === 'native' || filePath.startsWith('<core>')) continue
			return {
				functionName: match[1] ?? '',
				filePath,
				line: Number(match[3]),
			}
		}
		const filePath = match[1] ?? ''
		if (filePath === 'native' || filePath.startsWith('<core>')) continue
		return {
			functionName: '',
			filePath,
			line: Number(match[2]),
		}
	}
	throw new Error(`No stack frame found in:\n${stack}`)
}

Deno.test('inspector console: top frame matches Error.stack call site', () => {
	const events: Array<{ ev: unknown; params: ConsolePayload }> = []
	const endpoint = {
		emit(ev: unknown, params: unknown) {
			events.push({ ev, params: params as ConsolePayload })
		},
	}
	const serializer = {
		serialize(value: unknown) {
			return { type: typeof value, value: String(value) }
		},
	}
	const hooks = new Hooks(endpoint as never, serializer as never)
	;(hooks as any).installConsole()

	try {
		function logInfo(message: string): void {
			console.info(message)
		}

		function handleConnection(): string {
			const stack = new Error('probe').stack ?? ''; logInfo('console probe'); return stack
		}

		const expected = parseTopUserFrame(handleConnection())
		const payload = events[0]?.params
		ok(payload)
		const top = payload.callFrames?.[0]
		ok(top)
		strictEqual(top.functionName, expected.functionName)
		strictEqual(top.scriptId, expected.filePath)
		strictEqual(top.lineNumber + 1, expected.line)
	} finally {
		hooks.teardown()
	}
})
