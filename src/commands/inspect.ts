export interface InspectOptions {
	port: number
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
		breakOnStart: repl ? false : hasInspectBrk,
		waitForClient: repl ? hasInspectBrk || hasInspectWait : hasInspectWait,
	}
}

function parseInspectPort(raw: string | boolean | undefined): number {
	if (typeof raw !== 'string' || raw === 'true') return 9229
	const match = raw.match(/(?:^|:)(\d+)$/)
	if (!match) return 9229
	return Number(match[1]) || 9229
}
