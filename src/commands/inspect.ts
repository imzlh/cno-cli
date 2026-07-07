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

	return {
		port: parseInspectPort(raw),
		host: parseInspectHost(raw),
		breakOnStart: repl ? false : hasInspectBrk,
		waitForClient: repl ? hasInspectBrk || hasInspectWait : hasInspectWait,
	}
}

function parseInspectPort(raw: string | boolean | undefined): number {
	if (typeof raw !== 'string' || raw === 'true') return 9229
	const trimmed = raw.trim()
	const match = trimmed.match(/(?:^|:)\s*(\d+)$/)
	if (!match) return 9229
	return Number(match[1]) || 9229
}

function parseInspectHost(raw: string | boolean | undefined): string {
	if (typeof raw !== 'string' || raw === 'true') return '127.0.0.1'
	const trimmed = raw.trim()
	if (!trimmed) return '127.0.0.1'
	const match = trimmed.match(/^(.*):(\d+)$/)
	if (match) {
		const host = match[1]?.trim()
		return host || '127.0.0.1'
	}
	return '127.0.0.1'
}
