const { tryLoadOxc, oxcExtPath, nativeModuleRegister } = await import('file:///home/iz/cno-cli/cts/src/oxc.ts')
let direct: unknown = null
let directErr: unknown = null
try {
	const mod = import.meta.use('oxc') as Record<string, unknown>
	direct = {
		keys: Object.getOwnPropertyNames(mod),
		version: mod.version,
		transpile: typeof mod.transpile,
		scanImports: typeof mod.scanImports,
		transpileFast: typeof mod.transpileFast,
	}
} catch (error) {
	directErr = String(error)
}
console.log(JSON.stringify({
	register: typeof import.meta.register,
	symbolRegister: typeof globalThis[Symbol.for('cjs.internal.register')],
	extPath: oxcExtPath(),
	oxc: !!tryLoadOxc(),
	direct,
	directErr,
}))
