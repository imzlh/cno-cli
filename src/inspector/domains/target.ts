/**
 * domains/target.ts — Target CDP domain (worker thread).
 *
 * cno exposes a single fixed target (the running script). The handlers are
 * mostly stubs that report that one target so DevTools' target plumbing is
 * satisfied.
 */

import { isRecord, parseCDPMessage, type CDPMessage } from '../shared/cdp'
import {
	CDPError,
	CdpErrorCode,
	formatCdpError,
	type CDPDispatcher,
	type CdpParams,
	type EmitEvent,
} from '../worker/dispatcher'
import { Domain } from './base'

const TARGET_ID = 'cno-debug-1'
const SESSION_ID = 'cno-session-1'
const TARGET_TYPE = 'page'

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
		this.on('Target.sendMessageToTarget', (p) => this.sendMessageToTarget(p))
		this.on('Target.exposeDevToolsProtocol', () => ({}))
	}

	setEntryUrl(url: string): void {
		this.entryUrl = url
	}

	private async sendMessageToTarget(p: CdpParams): Promise<Record<string, never>> {
		const sessionId = this.str(p, 'sessionId') ?? SESSION_ID
		const raw = this.reqStr(p, 'message')
		const response = await this.dispatchNestedMessage(raw)
		if (response) {
			this.event('Target.receivedMessageFromTarget', {
				sessionId,
				targetId: TARGET_ID,
				message: JSON.stringify(response),
			})
		}
		return {}
	}

	private async dispatchNestedMessage(raw: string): Promise<CDPMessage | null> {
		let message: CDPMessage | null
		try {
			message = parseCDPMessage(raw)
		} catch {
			throw new CDPError(CdpErrorCode.InvalidParams, 'Target message must be valid JSON')
		}
		if (!message) throw new CDPError(CdpErrorCode.InvalidRequest, 'Target message must be a JSON object')
		const { id, method, params } = message
		if (id == null) return null
		if (!method) {
			return { id, error: { code: CdpErrorCode.InvalidRequest, message: 'CDP command method is required' } }
			}
			try {
				const result = await this.dispatcher.dispatch(method, normalizeNestedParams(params))
				return { id, result: result ?? {} }
			} catch (error) {
			return { id, error: formatCdpError(error) }
		}
	}

	private makeTarget(attached = true): TargetInfo {
		return {
			targetId: TARGET_ID,
			type: TARGET_TYPE,
			title: 'cno',
			url: this.entryUrl,
			attached,
			canAccessOpener: false,
			browserContextId: '',
		}
	}
}

function normalizeNestedParams(params: unknown): CdpParams {
	if (params == null) return {}
	if (!isRecord(params)) {
		throw new CDPError(CdpErrorCode.InvalidParams, 'CDP params must be an object')
	}
	return params
}
