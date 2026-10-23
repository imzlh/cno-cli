/**
 * domains/protocol.ts — low-risk CDP support domains.
 *
 * DevTools probes a few optional domains while attaching. Keep this list close
 * to Node/V8 debugging and avoid browser/page identity.
 */

import { CDPError, CdpErrorCode, type CDPDispatcher, type EmitEvent } from '../worker/dispatcher';
import type { WorkerEndpoint } from '../transport/worker-endpoint';
import { Domain } from './base';

export class ProtocolDomain extends Domain {
	constructor(dispatcher: CDPDispatcher, event: EmitEvent, private readonly rpc: WorkerEndpoint) {
		super(dispatcher, event)
		this.registerHandlers()
	}

	private registerHandlers(): void {
		this.on('Schema.getDomains', () => ({
			domains: [
				'Runtime', 'Debugger', 'Console', 'Network', 'Fetch',
				'Target', 'Schema', 'Log', 'Profiler', 'HeapProfiler', 'CNO',
			].map((name) => ({ name, version: '1.3' })),
		}))

		this.noop('Log.enable')
		this.noop('Log.disable')
		this.noop('Log.clear')
		this.noop('Log.startViolationsReport')
		this.noop('Log.stopViolationsReport')

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
		this.on('HeapProfiler.collectGarbage', () => this.rpc.call('collectGarbage', {}))
		for (const method of ['startTrackingHeapObjects', 'stopTrackingHeapObjects', 'takeHeapSnapshot']) {
			this.on(`HeapProfiler.${method}`, () => {
				throw new CDPError(CdpErrorCode.ServerError, `HeapProfiler.${method} is not supported by QuickJS; use CNO.getMemoryUsage for memory counters`)
			})
		}
		this.on('CNO.getMemoryUsage', () => this.rpc.call('getMemoryUsage', {}))
	}

	private noop(method: string): void {
		this.on(method, () => ({}))
	}

}

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
