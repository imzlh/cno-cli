/**
 * domains/page.ts — Page CDP domain (worker thread).
 *
 * cno has no DOM, but DevTools needs a frame + lifecycle events to show the
 * Sources tree and “page loaded” state. We synthesize a single frame and emit
 * frameNavigated / domContentEventFired / loadEventFired around the script's
 * lifecycle, replaying them if DevTools connects after start.
 */

import { Domain } from './base'
import type { CDPDispatcher, EmitEvent } from '../worker/dispatcher'

const FRAME_ID = 'cno-frame-1'
const LOADER_ID = 'cno-loader-1'

interface Frame {
	id: string
	loaderId: string
	url: string
	domainAndRegistry: string
	securityOrigin: string
	mimeType: string
	secureContextType: string
	crossOriginIsolatedContextType: string
	gatedAPIFeatures: string[]
}

export class PageDomain extends Domain {
	private enabled = false
	private connected = false
	private entryUrl = 'about:blank'
	private domContentFired = false
	private loadFired = false
	private resources: Array<{ url: string }> = []

	constructor(dispatcher: CDPDispatcher, event: EmitEvent) {
		super(dispatcher, event)

		this.on('Page.enable', () => {
			this.enabled = true
			if (this.connected) {
				const ts = Date.now() / 1000
				this.event('Page.frameNavigated', { frame: this.makeFrame(), type: 'Navigation' })
				if (this.domContentFired) {
					this.event('Page.domContentEventFired', { timestamp: ts })
					this.event('Page.lifecycleEvent', { frameId: FRAME_ID, loaderId: LOADER_ID, name: 'DOMContentLoaded', timestamp: ts })
				}
				if (this.loadFired) {
					this.event('Page.loadEventFired', { timestamp: ts })
					this.event('Page.lifecycleEvent', { frameId: FRAME_ID, loaderId: LOADER_ID, name: 'load', timestamp: ts })
				}
			}
			return {}
		})
		this.on('Page.disable', () => {
			this.enabled = false
			this.resources = []
			return {}
		})

		this.on('Page.reload', () => ({}))
		this.on('Page.navigate', () => ({ frameId: FRAME_ID, loaderId: LOADER_ID, errorText: 'Cannot navigate' }))
		this.on('Page.getFrameTree', () => ({ frameTree: { frame: this.makeFrame(), childFrames: [] } }))
		this.on('Page.getResourceTree', () => ({
			frameTree: {
				frame: this.makeFrame(),
				childFrames: [],
				resources: this.resources.map((r) => ({
					url: r.url, type: 'Script', mimeType: 'text/javascript', failed: false, canceled: false,
				})),
			},
		}))
		this.on('Page.getNavigationHistory', () => ({
			currentIndex: 0,
			entries: [{ id: 1, url: this.entryUrl, userTypedURL: this.entryUrl, title: 'cno', transitionType: 'typed' }],
		}))

		this.on('Page.setLifecycleEventsEnabled', () => ({}))
		this.on('Page.addScriptToEvaluateOnNewDocument', () => ({ identifier: '0' }))
		this.on('Page.removeScriptToEvaluateOnNewDocument', () => ({}))
		this.on('Page.createIsolatedWorld', () => ({ executionContextId: 1 }))
		this.on('Page.setBypassCSP', () => ({}))
		this.on('Page.captureScreenshot', () => ({ data: '' }))
		this.on('Page.printToPDF', () => ({ data: '' }))
		this.on('Page.setDeviceMetricsOverride', () => ({}))
		this.on('Page.clearDeviceMetricsOverride', () => ({}))
		this.on('Page.setEmulatedMedia', () => ({}))
		this.on('Page.setInterceptFileChooserDialog', () => ({}))
		this.on('Page.getInstallabilityErrors', () => ({ installabilityErrors: [] }))
		this.on('Page.getManifestIcons', () => ({}))
		this.on('Page.getAppId', () => ({}))
		this.on('Page.resetNavigationHistory', () => ({}))
		this.on('Page.setDocumentContent', () => ({}))
		this.on('Page.handleJavaScriptDialog', () => ({}))
		this.on('Page.getLayoutMetrics', () => ({
			layoutViewport: { pageX: 0, pageY: 0, clientWidth: 800, clientHeight: 600 },
			visualViewport: { offsetX: 0, offsetY: 0, pageX: 0, pageY: 0, clientWidth: 800, clientHeight: 600, scale: 1, zoom: 1 },
			contentSize: { x: 0, y: 0, width: 800, height: 600 },
			cssLayoutViewport: { pageX: 0, pageY: 0, clientWidth: 800, clientHeight: 600 },
			cssVisualViewport: { offsetX: 0, offsetY: 0, pageX: 0, pageY: 0, clientWidth: 800, clientHeight: 600, scale: 1, zoom: 1 },
			cssContentSize: { x: 0, y: 0, width: 800, height: 600 },
		}))
	}

	onConnected(entryUrl: string): void {
		if (entryUrl) this.entryUrl = entryUrl
		this.connected = true
		if (!this.enabled) return
		const ts = Date.now() / 1000
		this.event('Page.frameNavigated', { frame: this.makeFrame(), type: 'Navigation' })
		if (!this.domContentFired) {
			this.domContentFired = true
			this.event('Page.domContentEventFired', { timestamp: ts })
		}
		if (this.loadFired) this.event('Page.loadEventFired', { timestamp: ts })
	}

	onScriptParsed(url: string): void {
		if (!this.resources.find((r) => r.url === url)) this.resources.push({ url })
	}

	onLoad(timestamp: number): void {
		this.loadFired = true
		if (!this.enabled) return
		this.event('Page.loadEventFired', { timestamp })
		this.event('Page.lifecycleEvent', { frameId: FRAME_ID, loaderId: LOADER_ID, name: 'load', timestamp })
	}

	onDOMContent(timestamp: number): void {
		if (this.domContentFired) return
		this.domContentFired = true
		if (!this.enabled) return
		this.event('Page.domContentEventFired', { timestamp })
		this.event('Page.lifecycleEvent', { frameId: FRAME_ID, loaderId: LOADER_ID, name: 'DOMContentLoaded', timestamp })
	}

	private makeFrame(): Frame {
		return {
			id: FRAME_ID,
			loaderId: LOADER_ID,
			url: this.entryUrl,
			domainAndRegistry: '',
			securityOrigin: 'null',
			mimeType: 'text/javascript',
			secureContextType: 'InsecureScheme',
			crossOriginIsolatedContextType: 'NotIsolated',
			gatedAPIFeatures: [],
		}
	}
}
