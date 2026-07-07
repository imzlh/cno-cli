/**
 * domains/protocol.ts — low-risk CDP support domains.
 *
 * DevTools probes several browser-oriented domains while attaching. cno has no
 * DOM or browser process, so these handlers return minimal protocol-shaped
 * answers instead of surfacing noisy "method not found" errors.
 */

import pkg from '../../../package.json';
import type { CDPDispatcher, EmitEvent } from '../worker/dispatcher';
import { Domain } from './base';

const FRAME_ID = 'cno-frame-1'
const { version } = pkg as { version: string };
const engine = import.meta.use('engine');

export class ProtocolDomain extends Domain {
	constructor(dispatcher: CDPDispatcher, event: EmitEvent) {
		super(dispatcher, event)
		this.registerHandlers()
	}

	private registerHandlers(): void {
		this.on('Schema.getDomains', () => ({
			domains: [
				'Runtime', 'Debugger', 'Console', 'Page', 'Network', 'Fetch',
				'Target', 'Schema', 'Browser', 'Log', 'Security', 'Performance',
				'Profiler', 'HeapProfiler', 'DOM', 'CSS', 'Overlay', 'Emulation',
			].map((name) => ({ name, version: '1.3' })),
		}))

		this.on('Browser.getVersion', () => ({
			protocolVersion: '1.3',
			product: 'cno/' + version,
			revision: '',
			userAgent: 'cno',
			jsVersion: 'qjs/' + engine.versions.quickjs,
		}))
		this.on('Browser.getWindowForTarget', () => ({ windowId: 1, bounds: { left: 0, top: 0, width: 800, height: 600, windowState: 'normal' } }))
		this.noop('Browser.setDockTile')
		this.noop('Browser.close')

		this.noop('Log.enable')
		this.noop('Log.disable')
		this.noop('Log.clear')
		this.noop('Log.startViolationsReport')
		this.noop('Log.stopViolationsReport')

		this.noop('Security.enable')
		this.noop('Security.disable')
		this.noop('Security.setIgnoreCertificateErrors')
		this.noop('Security.setOverrideCertificateErrors')
		this.noop('Security.handleCertificateError')

		this.noop('ServiceWorker.enable')
		this.noop('ServiceWorker.disable')
		this.noop('ServiceWorker.stopAllWorkers')
		this.on('ServiceWorker.canInspectWorkers', () => ({ result: false }))

		this.noop('Performance.enable')
		this.noop('Performance.disable')
		this.noop('Performance.setTimeDomain')
		this.on('Performance.getMetrics', () => ({ metrics: [] }))

		this.noop('Profiler.enable')
		this.noop('Profiler.disable')
		this.noop('Profiler.start')
		this.on('Profiler.stop', () => ({ profile: emptyProfile() }))
		this.on('Profiler.takePreciseCoverage', () => ({ result: [], timestamp: Date.now() / 1000 }))
		this.on('Profiler.startPreciseCoverage', () => ({ timestamp: Date.now() / 1000 }))
		this.noop('Profiler.stopPreciseCoverage')
		this.noop('Profiler.setSamplingInterval')

		this.noop('HeapProfiler.enable')
		this.noop('HeapProfiler.disable')
		this.noop('HeapProfiler.collectGarbage')
		this.noop('HeapProfiler.startTrackingHeapObjects')
		this.noop('HeapProfiler.stopTrackingHeapObjects')
		this.noop('HeapProfiler.takeHeapSnapshot')

		this.noop('DOM.enable')
		this.noop('DOM.disable')
		this.on('DOM.getDocument', () => ({ root: this.rootNode() }))
		this.on('DOM.getFlattenedDocument', () => ({ nodes: [this.rootNode()] }))
		this.on('DOM.requestChildNodes', () => ({}))
		this.on('DOM.querySelector', () => ({ nodeId: 0 }))
		this.on('DOM.querySelectorAll', () => ({ nodeIds: [] }))

		this.noop('CSS.enable')
		this.noop('CSS.disable')
		this.on('CSS.getStyleSheetsForNode', () => ({ headers: [] }))
		this.on('CSS.getMatchedStylesForNode', () => ({ matchedCSSRules: [], inherited: [], pseudoElements: [] }))
		this.on('CSS.getComputedStyleForNode', () => ({ computedStyle: [] }))

		for (const domain of ['Overlay', 'Emulation', 'Storage', 'IndexedDB', 'DOMStorage', 'Audits']) {
			this.registerNoopPrefix(domain)
		}
	}

	private noop(method: string): void {
		this.on(method, () => ({}))
	}

	private registerNoopPrefix(domain: string): void {
		for (const method of COMMON_NOOP_METHODS) this.noop(`${domain}.${method}`)
	}

	private rootNode(): Record<string, unknown> {
		return {
			nodeId: 1,
			backendNodeId: 1,
			nodeType: 9,
			nodeName: '#document',
			localName: '',
			nodeValue: '',
			documentURL: 'about:blank',
			baseURL: 'about:blank',
			xmlVersion: '',
			compatibilityMode: 'NoQuirksMode',
			frameId: FRAME_ID,
			childNodeCount: 0,
			children: [],
		}
	}
}

const COMMON_NOOP_METHODS = [
	'enable',
	'disable',
	'clear',
	'setShowViewportSizeOnResize',
	'setShowAdHighlights',
	'setPausedInDebuggerMessage',
	'setDeviceMetricsOverride',
	'clearDeviceMetricsOverride',
	'setTouchEmulationEnabled',
	'setEmulatedMedia',
	'setScriptExecutionDisabled',
	'setLocaleOverride',
	'setTimezoneOverride',
	'clearDataForOrigin',
	'getUsageAndQuota',
	'trackCacheStorageForOrigin',
	'untrackCacheStorageForOrigin',
	'trackIndexedDBForOrigin',
	'untrackIndexedDBForOrigin',
	'requestDatabaseNames',
	'requestDatabase',
	'requestData',
] as const

function emptyProfile(): Record<string, unknown> {
	const now = Date.now() / 1000
	return {
		nodes: [{ id: 1, callFrame: { functionName: '(root)', scriptId: '0', url: '', lineNumber: 0, columnNumber: 0 }, hitCount: 0 }],
		startTime: now,
		endTime: now,
		samples: [],
		timeDeltas: [],
	}
}
