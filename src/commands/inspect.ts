export interface InspectOptions {
	port: number
	host: string
	breakOnStart: boolean
	waitForClient: boolean
}

export function parseInspectFlags(flags: Record<string, string | boolean>, repl = false): InspectOptions | null {
	const hasInspect = 'inspect' in flags
	const hasInspectBrk = 'inspect-brk' in flags
	const hasInspectWait = 'inspect-wait' in flags
	if (!hasInspect && !hasInspectBrk && !hasInspectWait) return null

	const raw = hasInspectBrk ? flags['inspect-brk']
		: hasInspectWait ? flags['inspect-wait']
			: flags['inspect']
	const address = parseInspectAddress(raw)

	return {
		port: address.port,
		host: address.host,
		breakOnStart: repl ? false : hasInspectBrk,
		waitForClient: repl ? hasInspectBrk || hasInspectWait : hasInspectWait,
	}
}

function parseInspectAddress(raw: string | boolean | undefined): Pick<InspectOptions, 'host' | 'port'> {
	if (typeof raw !== 'string' || raw === 'true') return { host: '127.0.0.1', port: 9229 }
	const trimmed = raw.trim()
	if (!trimmed) return { host: '127.0.0.1', port: 9229 }

	const port = (value: string): number => Number(value) || 9229
	if (/^\d+$/.test(trimmed)) return { host: '127.0.0.1', port: port(trimmed) }

	const bracketed = trimmed.match(/^\[([^\]]+)\](?::\s*(\d+))?$/)
	if (bracketed) {
		return { host: bracketed[1]!.trim() || '127.0.0.1', port: bracketed[2] ? port(bracketed[2]) : 9229 }
	}

	const firstColon = trimmed.indexOf(':')
	const lastColon = trimmed.lastIndexOf(':')
	if (firstColon === lastColon && lastColon >= 0) {
		const portText = trimmed.slice(lastColon + 1).trim()
		if (/^\d+$/.test(portText)) {
			return { host: trimmed.slice(0, lastColon).trim() || '127.0.0.1', port: port(portText) }
		}
	}

	return { host: trimmed, port: 9229 }
}
