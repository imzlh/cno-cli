import type { Inspector } from './main/inspector'

// Published on the evbus `cno.inspector` channel; node:inspector discovers it
// there. The native module ships with the pinned circu.js core.
const evbus = import.meta.use('evbus')
const INSPECTOR_NAMESPACE = 'cno.inspector'
const INSPECTOR_BRIDGE_KEY = 'bridge'

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
	evbus.set(INSPECTOR_NAMESPACE, INSPECTOR_BRIDGE_KEY, bridge)
	return bridge
}

export function uninstallInspectorBridge(bridge: InspectorBridge): void {
	if (evbus.get(INSPECTOR_NAMESPACE, INSPECTOR_BRIDGE_KEY) === bridge) {
		evbus.delete(INSPECTOR_NAMESPACE, INSPECTOR_BRIDGE_KEY)
	}
}

// `Inspector` is the heavy part of the CDP tree and most runs never open it,
// so it is imported on first use rather than with this module.
async function loadInspector(): Promise<typeof Inspector> {
	return (await import('./main/inspector')).Inspector
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

		// Track loading as part of opening so concurrent callers share it and
		// close() can cancel before the inspector has been constructed.
		opening = (async () => {
			const PendingInspector = await loadInspector()
			if (disposed || closing) throw new Error('Inspector bridge is closed')
			const inspector = new PendingInspector({
				port: openOptions.port ?? 9229,
				host: openOptions.host ?? '127.0.0.1',
				entryFile: options.entryFile,
			})
			publish(inspector)
			try {
				await inspector.attach()
				if (disposed || closing || current() !== inspector) throw new Error('Inspector bridge is closed')
				options.onOpen?.(inspector)
				return inspector
			} catch (error) {
				try { await inspector.detach() } catch { /* preserve the attach failure */ }
				if (current() === inspector) publish(null)
				throw error
			}
		})().finally(() => { opening = null })

		return opening
	}

	const close = (): Promise<void> => {
		if (closing) return closing
		const inspector = current()
		const pending = opening
		if (!inspector && !pending) return Promise.resolve()
		closing = (async () => {
			try { await inspector?.detach() }
			finally {
				try { await pending } catch { /* opening owns its failure */ }
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
