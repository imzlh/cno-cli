/**
 * inspector/shared/user-files.ts — distinguishes user source from runtime
 * internals.
 *
 * The pause controller uses this to skip breaks that land inside engine/runtime
 * code so the user never sees internal frames in DevTools.
 */

const INTERNAL_PREFIXES = ['<core>', '<devtools>', '<compiled>', '<eval>', 'node:'];

export function isUserFile(file: string): boolean {
	if (!file) return false;
	for (const p of INTERNAL_PREFIXES) {
		if (file.startsWith(p)) return false;
	}
	return true;
}
