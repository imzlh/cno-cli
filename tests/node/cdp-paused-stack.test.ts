import { ok, strictEqual } from 'node:assert'
import { spawn } from 'node:child_process'
import { resolve } from 'node:path'

const HOST = '127.0.0.1'
const PORT = 9241
const TIMEOUT_MS = 15_000
const CNO = resolve('build/stage/cno')
const TARGET = resolve('tests/node/targets/cdp-pause-stack.target.ts')

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms))
}

async function getJson(path: string) {
	const deadline = Date.now() + TIMEOUT_MS
	let last: unknown = null
	while (Date.now() < deadline) {
		try {
			const res = await fetch(`http://${HOST}:${PORT}${path}`)
			if (res.ok) return await res.json()
		} catch (error) {
			last = error
		}
		await sleep(120)
	}
	throw last ?? new Error(`timeout fetching ${path}`)
}

async function discoverWsUrl(): Promise<string> {
	const version = await getJson('/json/version') as { webSocketDebuggerUrl?: string }
	const wsUrl = version.webSocketDebuggerUrl
	if (!wsUrl) throw new Error('missing webSocketDebuggerUrl')
	return wsUrl
}

class WsSession {
	private readonly ws: WebSocket
	private nextId = 1
	private readonly pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void }>()
	private readonly notifications: Array<{ method: string; params: any }> = []

	private constructor(ws: WebSocket) {
		this.ws = ws
		ws.addEventListener('message', (ev) => {
			const msg = JSON.parse(typeof ev.data === 'string' ? ev.data : '')
			if (typeof msg.id === 'number') {
				const pending = this.pending.get(msg.id)
				if (!pending) return
				this.pending.delete(msg.id)
				if (msg.error) pending.reject(new Error(msg.error.message || 'protocol error'))
				else pending.resolve(msg.result)
				return
			}
			if (typeof msg.method === 'string') this.notifications.push({ method: msg.method, params: msg.params })
		})
	}

	static async connect(wsUrl: string): Promise<WsSession> {
		const ws = new WebSocket(wsUrl)
		await new Promise<void>((resolve, reject) => {
			const timer = setTimeout(() => reject(new Error('ws open timeout')), TIMEOUT_MS)
			ws.addEventListener('open', () => {
				clearTimeout(timer)
				resolve()
			}, { once: true })
			ws.addEventListener('error', () => {
				clearTimeout(timer)
				reject(new Error('ws error'))
			}, { once: true })
		})
		return new WsSession(ws)
	}

	command(method: string, params: Record<string, unknown> = {}): Promise<unknown> {
		return new Promise((resolve, reject) => {
			const id = this.nextId++
			this.pending.set(id, { resolve, reject })
			this.ws.send(JSON.stringify({ id, method, params }))
		})
	}

	async waitFor(method: string): Promise<any> {
		const deadline = Date.now() + TIMEOUT_MS
		while (Date.now() < deadline) {
			const index = this.notifications.findIndex((item) => item.method === method)
			if (index !== -1) {
				const [found] = this.notifications.splice(index, 1)
				return found?.params
			}
			await sleep(20)
		}
		throw new Error(`timeout waiting for ${method}`)
	}

	close(): void {
		try { this.ws.close() } catch {}
	}
}

function waitForExpectedFrame(child: ReturnType<typeof spawn>): Promise<{ functionName: string; filePath: string; line: number }> {
	return new Promise((resolve, reject) => {
		let stdout = ''
		const timer = setTimeout(() => reject(new Error('stdout timeout')), TIMEOUT_MS)
		child.stdout?.on('data', (chunk) => {
			stdout += String(chunk)
			for (const line of stdout.split('\n')) {
				const match = line.match(/^EXPECTED_FRAME\s+(.+)$/)
				if (!match) continue
				clearTimeout(timer)
				resolve(JSON.parse(match[1] ?? '{}'))
				return
			}
		})
		child.on('exit', () => {
			clearTimeout(timer)
			reject(new Error(`child exited before EXPECTED_FRAME:\n${stdout}`))
		})
	})
}

interface PausedFrame {
	functionName?: string
	scriptId?: string
	line: number
}

async function runPauseOnce(): Promise<PausedFrame> {
	const child = spawn(CNO, ['run', `--inspect-wait=${HOST}:${PORT}`, TARGET], {
		stdio: ['ignore', 'pipe', 'inherit'],
	})

	let session: WsSession | null = null
	try {
		const expectedPromise = waitForExpectedFrame(child)
		const wsUrl = await discoverWsUrl()
		session = await WsSession.connect(wsUrl)
		await session.command('Debugger.enable')
		await session.command('Runtime.enable')
		await session.command('Runtime.runIfWaitingForDebugger')

		const [expected, paused] = await Promise.all([
			expectedPromise,
			session.waitFor('Debugger.paused'),
		]) as [
			{ functionName: string; filePath: string; line: number },
			{ callFrames?: Array<{ functionName?: string; location?: { scriptId?: string; lineNumber?: number } }> },
		]

		const top = paused.callFrames?.[0]
		ok(top)
		console.log(JSON.stringify({ expected, top }, null, 2))
		strictEqual(top.functionName, expected.functionName)
		strictEqual(top.location?.scriptId, expected.filePath)
		strictEqual((top.location?.lineNumber ?? -999) + 1, expected.line)

		return {
			functionName: top.functionName,
			scriptId: top.location?.scriptId,
			line: (top.location?.lineNumber ?? -999) + 1,
		}
	} finally {
		try { await session?.command('Debugger.resume') } catch {}
		session?.close()
		child.kill('SIGKILL')
		await new Promise((resolve) => child.on('exit', resolve))
	}
}

Deno.test({ name: 'cdp: paused top frame matches Error.stack call site', timeout: 20_000 }, async () => {
	// Run twice against the same target path: the first run compiles fresh
	// (cold .jsc cache), the second hits the just-written .jsc cache. Both
	// must report the identical paused location -- regression test for a bug
	// where the cached-bytecode run reported a line 2 off from the fresh run
	// (see JS_WriteFunctionTag's pc2line remap in quickjs.c).
	const cold = await runPauseOnce()
	const cached = await runPauseOnce()
	strictEqual(cached.line, cold.line)
	strictEqual(cached.scriptId, cold.scriptId)
	strictEqual(cached.functionName, cold.functionName)
})
