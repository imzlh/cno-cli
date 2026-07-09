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

function handleConnection(): void {
	const expected = parseTopUserFrame(new Error('probe').stack ?? ''); console.log(`EXPECTED_FRAME ${JSON.stringify(expected)}`); debugger
}

handleConnection()
