/** Distinguishes user source from runtime internals so the debugger never pauses inside them. */

const INTERNAL_PREFIXES = ['<core>', '<devtools>', '<compiled>', '<eval>', 'node:'];

export function isUserFile(file: string): boolean {
	if (!file) return false;
	for (const p of INTERNAL_PREFIXES) {
		if (file.startsWith(p)) return false;
	}
	return true;
}
