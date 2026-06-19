#!/usr/bin/env node
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { spawn } from 'node:child_process'

const args = parseArgs(process.argv.slice(2))
const runtime = args.runtime ?? 'deno'
const port = Number(args.port ?? 9339)
const host = args.host ?? '127.0.0.1'
const timeoutMs = Number(args.timeout ?? 10_000)
const outFile = resolve(args.out ?? `.tmp/cdp-console-${runtimeName(runtime)}.json`)
const keepSample = args.keep === true

if (typeof WebSocket !== 'function') {
	console.error('This script needs Node.js with global WebSocket support.')
	process.exit(1)
}

await mkdir(resolve('.tmp'), { recursive: true })
const tempDir = await mkdtemp(join(tmpdir(), 'cno-cdp-console-'))
const sampleFile = join(tempDir, 'console-sample.ts')
await writeFile(sampleFile, sampleSource(), 'utf8')

const inspectArg = `--inspect-wait=${host}:${port}`
const childArgs = isDenoRuntime(runtime)
	? ['run', inspectArg, sampleFile]
	: [inspectArg, 'run', sampleFile]

console.error(`launch: ${runtime} ${childArgs.join(' ')}`)
const child = spawn(runtime, childArgs, {
	stdio: ['ignore', 'pipe', 'pipe'],
	windowsHide: true,
})

let stderr = ''
let stdout = ''
let wsUrl = ''
child.stderr.setEncoding('utf8')
child.stdout.setEncoding('utf8')
child.stderr.on('data', chunk => {
	stderr += chunk
	process.stderr.write(chunk)
	wsUrl ||= findWsUrl(chunk)
})
child.stdout.on('data', chunk => {
	stdout += chunk
	process.stderr.write(chunk)
	wsUrl ||= findWsUrl(chunk)
})

const startedAt = Date.now()
try {
	wsUrl = await waitForWsUrl(() => wsUrl, host, port, timeoutMs)
	console.error(`connect: ${wsUrl}`)

	const ws = await openWebSocket(wsUrl)
	const cdp = createCdpClient(ws)
	const events = []
	const allEvents = []

	ws.addEventListener('message', event => {
		const msg = JSON.parse(String(event.data))
		if (!msg.method) return
		allEvents.push(msg)
		if (isInterestingEvent(msg)) {
			events.push(msg)
			console.error(`event: ${msg.method}`)
		}
	})

	await cdp.send('Runtime.enable')
	await cdp.send('Console.enable')
	await cdp.send('Debugger.enable')
	await cdp.send('Runtime.runIfWaitingForDebugger').catch(() => undefined)

	await waitForExitOrEvents(child, events, timeoutMs)
	ws.close()

	const result = {
		runtime,
		argv: [runtime, ...childArgs],
		sampleFile,
		outFile,
		durationMs: Date.now() - startedAt,
		stdout,
		stderr,
		events,
		scriptParsedForSample: allEvents.filter(e =>
			e.method === 'Debugger.scriptParsed' &&
			String(e.params?.url ?? '').includes('console-sample.ts')
		),
	}

	await writeFile(outFile, JSON.stringify(result, null, 2), 'utf8')
	console.log(JSON.stringify(result, null, 2))
	console.error(`saved: ${outFile}`)
} finally {
	if (!child.killed) child.kill()
	if (!keepSample) await rm(tempDir, { recursive: true, force: true })
}

function parseArgs(argv) {
	const out = {}
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i]
		if (!arg.startsWith('--')) continue
		const eq = arg.indexOf('=')
		if (eq !== -1) {
			out[arg.slice(2, eq)] = arg.slice(eq + 1)
			continue
		}
		const key = arg.slice(2)
		const next = argv[i + 1]
		if (!next || next.startsWith('--')) {
			out[key] = true
		} else {
			out[key] = next
			i++
		}
	}
	return out
}

function runtimeName(path) {
	return String(path).replace(/[^a-z0-9._-]+/gi, '_').replace(/^_+|_+$/g, '') || 'runtime'
}

function isDenoRuntime(path) {
	return /(?:^|[\\/])deno(?:\.exe)?$/i.test(String(path))
}

function findWsUrl(text) {
	return String(text).match(/ws:\/\/[^\s]+/)?.[0] ?? ''
}

async function waitForWsUrl(readBuffered, host, port, timeoutMs) {
	const deadline = Date.now() + timeoutMs
	while (Date.now() < deadline) {
		const buffered = readBuffered()
		if (buffered) return buffered
		const fromJson = await fetchInspectorJson(host, port)
		if (fromJson) return fromJson
		await delay(100)
	}
	throw new Error(`Timed out waiting for inspector WebSocket URL on ${host}:${port}`)
}

async function fetchInspectorJson(host, port) {
	try {
		const res = await fetch(`http://${host}:${port}/json/list`)
		if (!res.ok) return ''
		const list = await res.json()
		return list?.[0]?.webSocketDebuggerUrl ?? ''
	} catch {
		return ''
	}
}

function openWebSocket(url) {
	return new Promise(async (resolve, reject) => {
		await new Promise(resolve => setTimeout(resolve, 3000));
		const ws = new WebSocket(url)
		ws.addEventListener('open', () => resolve(ws), { once: true })
		ws.addEventListener('error', reject, { once: true })
	})
}

function createCdpClient(ws) {
	let id = 0
	const pending = new Map()
	ws.addEventListener('message', event => {
		const msg = JSON.parse(String(event.data))
		if (!msg.id) return
		const item = pending.get(msg.id)
		if (!item) return
		pending.delete(msg.id)
		if (msg.error) item.reject(new Error(`${item.method}: ${JSON.stringify(msg.error)}`))
		else item.resolve(msg.result)
	})
	return {
		send(method, params = {}) {
			const req = { id: ++id, method, params }
			ws.send(JSON.stringify(req))
			return new Promise((resolve, reject) => pending.set(req.id, { method, resolve, reject }))
		},
	}
}

function isInterestingEvent(msg) {
	if (msg.method === 'Runtime.consoleAPICalled') return true
	if (msg.method === 'Console.messageAdded') return true
	if (msg.method === 'Runtime.exceptionThrown') return true
	return msg.method === 'Debugger.scriptParsed' &&
		String(msg.params?.url ?? '').includes('console-sample.ts')
}

async function waitForExitOrEvents(child, events, timeoutMs) {
	const deadline = Date.now() + timeoutMs
	while (Date.now() < deadline) {
		if (child.exitCode != null) return
		const consoleEvents = events.filter(e =>
			e.method === 'Runtime.consoleAPICalled' ||
			e.method === 'Console.messageAdded'
		)
		if (consoleEvents.length >= 4) {
			await delay(300)
			return
		}
		await delay(100)
	}
}

function delay(ms) {
	return new Promise(resolve => setTimeout(resolve, ms))
}

function sampleSource() {
	return `
function alpha() {
	beta("from beta")
}

function beta(msg) {
	const obj = { msg, answer: 42 }
	console.log("log marker", obj)
	console.warn("warn marker", obj)
	console.error("error marker", new Error("boom"))
	console.trace("trace marker")
}

alpha()
await new Promise(resolve => setTimeout(resolve, 50))
`.trimStart()
}
