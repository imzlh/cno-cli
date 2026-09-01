import { ok, strictEqual } from 'node:assert'
import { type ChildProcess, spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const HOST = '127.0.0.1'
const PORT = 9241

// Inner budgets MUST stay strictly below the outer Deno.test timeout, or the inner
// deadline can never expire first and every failure is reported as an opaque harness
// timeout instead of its real cause.
//
// Sizing is MEASURED, not guessed: on a cold cache the child's time-to-first-HTTP-
// response was 3,226ms for --inspect-wait. The per-test timeout does NOT cover the
// runner's own module load (a cold file taking 190s to import still passes a 10s
// per-test timeout). This test performs TWO sequential full `cno run` cycles (fresh
// then cached), so the outer timeout covers both at ~10x the observed figure.
const START_BUDGET_MS = 30_000
const WS_BUDGET_MS = 15_000
const STDOUT_BUDGET_MS = 30_000
const TEST_TIMEOUT_MS = 120_000

// The running binary, not a guessed path: `resolve('build/stage/cno')` has no `.exe`
// and cno's spawn rejects it with ENOENT on win32.
const CNO = Deno.execPath().replace(/ \(deleted\)$/, '')
// fileURLToPath, not URL.pathname: pathname yields `/D:/a/b` with forward slashes,
// while the runtime reports native separators in stack traces. Line 241 compares
// this against a frame path parsed from a live stack, so the separator form is
// load-bearing. Still cwd-independent, unlike resolve().
const TARGET = fileURLToPath(new URL('./targets/cdp-pause-stack.target.ts', import.meta.url))

/** A failure we can attribute; retrying it would only convert it into a timeout. */
class DefinitiveError extends Error {}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms))
}

interface Target {
	proc: ChildProcess
	readonly failure: Error | null
	stop(): Promise<void>
}

/**
 * Spawn the inspector target and latch any spawn failure; without the 'error' handler
 * a bad executable path surfaces only as the outer test timeout, never as its ENOENT.
 */
function startTarget(): Target {
	const proc = spawn(CNO, ['run', `--inspect-wait=${HOST}:${PORT}`, TARGET], {
		stdio: ['ignore', 'pipe', 'inherit'],
	})
	let failure: Error | null = null
	let stopping = false
	proc.on('error', (e: Error) => {
		failure ??= new DefinitiveError(`failed to spawn ${CNO}: ${e.message}`)
	})
	proc.on('exit', (code: number | null, signal: string | null) => {
		if (stopping) return
		failure ??= new DefinitiveError(
			`inspector target exited before serving (code=${code}, signal=${signal}); see its stderr above`,
		)
	})
	return {
		proc,
		get failure() {
			return failure
		},
		async stop() {
			stopping = true
			proc.kill('SIGKILL')
			if (proc.exitCode === null && proc.signalCode === null) {
				await new Promise((resolve) => proc.on('exit', resolve))
			}
		},
	}
}

/**
 * Poll until the endpoint answers 2xx. A transport error means "not listening yet" and
 * is retried; an HTTP status means the server answered and is definitive, so it is
 * surfaced immediately rather than retried into a timeout.
 */
async function getJson(path: string, target?: Target) {
	const deadline = Date.now() + START_BUDGET_MS
	let lastTransportError: unknown = null
	while (Date.now() < deadline) {
		if (target?.failure) throw target.failure
		try {
			const res = await fetch(`http://${HOST}:${PORT}${path}`)
			if (res.ok) return await res.json()
			const body = (await res.text()).slice(0, 200)
			throw new DefinitiveError(
				`GET ${path} -> HTTP ${res.status} ${res.statusText}${body ? ` body=${JSON.stringify(body)}` : ' (empty body)'}`,
			)
		} catch (error) {
			if (error instanceof DefinitiveError) throw error
			lastTransportError = error
		}
		await sleep(120)
	}
	const detail = lastTransportError instanceof Error ? lastTransportError.message : String(lastTransportError)
	throw new Error(`no 2xx from ${path} within ${START_BUDGET_MS}ms; last transport error: ${detail}`)
}

async function discoverWsUrl(target?: Target): Promise<string> {
	const version = await getJson('/json/version', target) as { webSocketDebuggerUrl?: string }
	const wsUrl = version.webSocketDebuggerUrl
	if (!wsUrl) throw new DefinitiveError('/json/version carried no webSocketDebuggerUrl')
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
			const timer = setTimeout(() => reject(new Error(`ws open to ${wsUrl} not completed within ${WS_BUDGET_MS}ms`)), WS_BUDGET_MS)
			ws.addEventListener('open', () => {
				clearTimeout(timer)
				resolve()
			}, { once: true })
			ws.addEventListener('error', () => {
				clearTimeout(timer)
				reject(new Error(`WebSocket to ${wsUrl} failed`))
			}, { once: true })
		})
		return new WsSession(ws)
	}

	/** Every command carries its own deadline; an unanswered one otherwise hangs until the harness kills the test. */
	command(method: string, params: Record<string, unknown> = {}): Promise<unknown> {
		return new Promise((resolve, reject) => {
			const id = this.nextId++
			const timer = setTimeout(() => {
				this.pending.delete(id)
				reject(new Error(`no reply to ${method} (id ${id}) within ${WS_BUDGET_MS}ms`))
			}, WS_BUDGET_MS)
			const settle = (fn: (value: any) => void) => (value: any) => {
				clearTimeout(timer)
				fn(value)
			}
			this.pending.set(id, { resolve: settle(resolve), reject: settle(reject) })
			this.ws.send(JSON.stringify({ id, method, params }))
		})
	}

	async waitFor(method: string): Promise<any> {
		const deadline = Date.now() + WS_BUDGET_MS
		while (Date.now() < deadline) {
			const index = this.notifications.findIndex((item) => item.method === method)
			if (index !== -1) {
				const [found] = this.notifications.splice(index, 1)
				return found?.params
			}
			await sleep(20)
		}
		throw new Error(`no ${method} notification within ${WS_BUDGET_MS}ms`)
	}

	close(): void {
		try { this.ws.close() } catch {}
	}
}

/**
 * Resolve on the target's EXPECTED_FRAME line. Rejects on an early exit or a spawn
 * failure so those report their real cause instead of stalling until the outer timeout.
 */
function waitForExpectedFrame(target: Target): Promise<{ functionName: string; filePath: string; line: number }> {
	const child = target.proc
	return new Promise((resolve, reject) => {
		let stdout = ''
		const timer = setTimeout(
			() => reject(new Error(`no EXPECTED_FRAME on stdout within ${STDOUT_BUDGET_MS}ms; got:\n${stdout}`)),
			STDOUT_BUDGET_MS,
		)
		child.on('error', (e: Error) => {
			clearTimeout(timer)
			reject(new DefinitiveError(`failed to spawn ${CNO}: ${e.message}`))
		})
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
		child.on('exit', (code: number | null, signal: string | null) => {
			clearTimeout(timer)
			reject(new DefinitiveError(`child exited before EXPECTED_FRAME (code=${code}, signal=${signal}):\n${stdout}`))
		})
	})
}

interface PausedFrame {
	functionName?: string
	scriptId?: string
	line: number
}

async function runPauseOnce(): Promise<PausedFrame> {
	const target = startTarget()

	let session: WsSession | null = null
	try {
		const expectedPromise = waitForExpectedFrame(target)
		// Mark the rejection observed. If discovery fails first, nothing ever awaits this
		// promise, and stop() then makes it reject with "child exited" -- which would
		// escape as an unhandled rejection and bury the real failure in the log. A second
		// handler does not consume the rejection: the Promise.all below still sees it.
		void expectedPromise.catch(() => {})
		const wsUrl = await discoverWsUrl(target)
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
		await target.stop()
	}
}

Deno.test({ name: 'cdp: paused top frame matches Error.stack call site', timeout: TEST_TIMEOUT_MS }, async () => {
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
