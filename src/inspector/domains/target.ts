/**
 * domains/target.ts — Target CDP domain (worker thread).
 *
 * cno exposes a single fixed target (the running script). The handlers are
 * mostly stubs that report that one target so DevTools' target plumbing is
 * satisfied.
 */

import { Domain } from './base'
import type { CDPDispatcher, EmitEvent } from '../worker/dispatcher'

const TARGET_ID = 'cno-debug-1'
const SESSION_ID = 'cno-session-1'

interface TargetInfo {
	targetId: string
	type: string
	title: string
	url: string
	attached: boolean
	canAccessOpener: boolean
	browserContextId: string
}

export class TargetDomain extends Domain {
	private entryUrl = 'file://'

	constructor(dispatcher: CDPDispatcher, event: EmitEvent) {
		super(dispatcher, event)

		this.on('Target.setDiscoverTargets', (p) => {
			if (this.bool(p, 'discover')) this.event('Target.targetCreated', { targetInfo: this.makeTarget() })
			return {}
		})
		this.on('Target.setAutoAttach', (p) => {
			if (this.bool(p, 'autoAttach')) {
				this.event('Target.attachedToTarget', {
					sessionId: SESSION_ID,
					targetInfo: this.makeTarget(),
					waitingForDebugger: false,
				})
			}
			return {}
		})
		this.on('Target.getTargets', () => ({ targetInfos: [this.makeTarget()] }))
		this.on('Target.getTargetInfo', () => ({ targetInfo: this.makeTarget() }))
		this.on('Target.activateTarget', () => ({}))
		this.on('Target.closeTarget', () => ({ success: false }))
		this.on('Target.detachFromTarget', () => ({}))
		this.on('Target.attachToTarget', () => ({ sessionId: SESSION_ID }))
		this.on('Target.createTarget', () => ({ targetId: TARGET_ID }))
		this.on('Target.getBrowserContexts', () => ({ browserContextIds: [] }))
		this.on('Target.createBrowserContext', () => ({ browserContextId: '' }))
		this.on('Target.disposeBrowserContext', () => ({}))
		this.on('Target.setRemoteLocations', () => ({}))
		this.on('Target.sendMessageToTarget', () => ({}))
		this.on('Target.exposeDevToolsProtocol', () => ({}))
	}

	setEntryUrl(url: string): void {
		this.entryUrl = url
	}

	private makeTarget(attached = true): TargetInfo {
		return {
			targetId: TARGET_ID,
			type: 'node',
			title: 'cno',
			url: this.entryUrl,
			attached,
			canAccessOpener: false,
			browserContextId: '',
		}
	}
}
