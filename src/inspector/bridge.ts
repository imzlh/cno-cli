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
	onOpen?: (inspector: Inspector) => void
	getCurrentInspector?: () => Inspector | null
	setCurrentInspector?: (inspector: Inspector | null) => void
}

export interface InstalledInspectorBridge extends InspectorBridge {
	dispose(): Promise<void>
}

export function installInspectorBridge(options: InspectorBridgeInstallOptions): InstalledInspectorBridge {
	const bridge = createInspectorBridge(options)
	Object.defineProperty(globalThis, INSPECTOR_BRIDGE, {
		value: bridge,
		writable: true,
		enumerable: false,
		configurable: true,
	})
	return bridge
}

export function uninstallInspectorBridge(bridge: InspectorBridge): void {
	if (Object.getOwnPropertyDescriptor(globalThis, INSPECTOR_BRIDGE)?.value === bridge) {
		Reflect.deleteProperty(globalThis, INSPECTOR_BRIDGE)
	}
}

function createInspectorBridge(options: InspectorBridgeInstallOptions): InstalledInspectorBridge {
	let opening: Promise<Inspector> | null = null
	let closing: Promise<void> | null = null
	let disposed = false
	let localInspector: Inspector | null = null

	const current = (): Inspector | null => options.getCurrentInspector ? options.getCurrentInspector() : localInspector
	const publish = (inspector: Inspector | null): void => {
		localInspector = inspector
		options.setCurrentInspector?.(inspector)
	}

	const ensureOpen = async (openOptions: OpenInspectorOptions = {}): Promise<Inspector> => {
		if (disposed) throw new Error('Inspector bridge is closed')
		if (closing) await closing
		if (disposed) throw new Error('Inspector bridge is closed')
		if (opening) return opening
		const existing = current()
		if (existing?.inspectorUrl) return existing

		const inspector = new Inspector({
			port: openOptions.port ?? 9229,
			host: openOptions.host ?? '127.0.0.1',
			entryFile: options.entryFile,
		})
		publish(inspector)

		opening = inspector.attach()
			.then(() => {
				if (disposed || closing || current() !== inspector) throw new Error('Inspector bridge is closed')
				options.onOpen?.(inspector)
				return inspector
			})
			.catch(async (error) => {
				try { await inspector.detach() } catch { /* preserve the attach failure */ }
				if (current() === inspector) publish(null)
				throw error
			})
			.finally(() => {
				opening = null
			})

		return opening
	}

	const close = (): Promise<void> => {
		if (closing) return closing
		const inspector = current()
		if (!inspector) return Promise.resolve()
		closing = (async () => {
			try { await inspector.detach() }
			finally {
				try { await opening } catch { /* opening owns its failure */ }
				if (current() === inspector) publish(null)
			}
		})().finally(() => { closing = null })
		return closing
	}

	const bridge: InstalledInspectorBridge = {
		async open(openOptions?: OpenInspectorOptions): Promise<string> {
			const inspector = await ensureOpen(openOptions)
			if (openOptions?.wait) await inspector.waitForDebugger()
			return inspector.inspectorUrl
		},
		close,
		dispose(): Promise<void> {
			disposed = true
			uninstallInspectorBridge(bridge)
			return close()
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
	return bridge
}
