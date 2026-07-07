import { Inspector } from './main/inspector'

const INSPECTOR_BRIDGE = Symbol.for('cno.inspector.bridge')

export interface OpenInspectorOptions {
	port?: number
	host?: string
	wait?: boolean
}

export interface InspectorBridge {
	open(options?: OpenInspectorOptions): Promise<string>
	close(): Promise<void>
	url(): string | undefined
	waitForConnection(): Promise<void>
	waitForDebugger(): Promise<void>
	isActive(): boolean
}

export interface InspectorBridgeInstallOptions {
	entryFile: string
	addInitHook?: (hook: NonNullable<Inspector['scriptInitHook']>) => void
	getCurrentInspector?: () => Inspector | null
	setCurrentInspector?: (inspector: Inspector | null) => void
}

export function installInspectorBridge(options: InspectorBridgeInstallOptions): void {
	const bridge = createInspectorBridge(options)
	Object.defineProperty(globalThis, INSPECTOR_BRIDGE, {
		value: bridge,
		writable: true,
		enumerable: false,
		configurable: true,
	})
}

export function uninstallInspectorBridge(): void {
	try {
		Reflect.deleteProperty(globalThis, INSPECTOR_BRIDGE)
	} catch {
		Reflect.set(globalThis, INSPECTOR_BRIDGE, undefined)
	}
}

function createInspectorBridge(options: InspectorBridgeInstallOptions): InspectorBridge {
	let opening: Promise<Inspector> | null = null

	const current = (): Inspector | null => options.getCurrentInspector?.() ?? null

	const publishHook = (inspector: Inspector): void => {
		const hook = inspector.scriptInitHook
		if (hook) options.addInitHook?.(hook)
	}

	const ensureOpen = async (openOptions: OpenInspectorOptions = {}): Promise<Inspector> => {
		if (opening) return opening
		const existing = current()
		if (existing?.inspectorUrl) return existing

		const inspector = new Inspector({
			port: openOptions.port ?? 9229,
			host: openOptions.host ?? '127.0.0.1',
			entryFile: options.entryFile,
		})
		options.setCurrentInspector?.(inspector)

		opening = inspector.attach()
			.then(() => {
				publishHook(inspector)
				return inspector
			})
			.catch((error) => {
				options.setCurrentInspector?.(null)
				throw error
			})
			.finally(() => {
				opening = null
			})

		return opening
	}

	return {
		async open(openOptions?: OpenInspectorOptions): Promise<string> {
			const inspector = await ensureOpen(openOptions)
			if (openOptions?.wait) await inspector.waitForDebugger()
			return inspector.inspectorUrl
		},
		async close(): Promise<void> {
			const inspector = current()
			if (!inspector) return
			await inspector.detach()
			options.setCurrentInspector?.(null)
		},
		url(): string | undefined {
			return current()?.inspectorUrl || undefined
		},
		async waitForConnection(): Promise<void> {
			const inspector = await ensureOpen()
			await inspector.waitForConnection()
		},
		async waitForDebugger(): Promise<void> {
			const inspector = await ensureOpen()
			await inspector.waitForDebugger()
		},
		isActive(): boolean {
			return current() != null
		},
	}
}
