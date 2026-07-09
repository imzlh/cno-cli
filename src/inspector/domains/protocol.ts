/**
 * domains/protocol.ts — low-risk CDP support domains.
 *
 * DevTools probes a few optional domains while attaching. Keep this list close
 * to Node/V8 debugging and avoid browser/page identity.
 */

import type { CDPDispatcher, EmitEvent } from '../worker/dispatcher';
import { Domain } from './base';

export class ProtocolDomain extends Domain {
	constructor(dispatcher: CDPDispatcher, event: EmitEvent) {
		super(dispatcher, event)
		this.registerHandlers()
	}

	private registerHandlers(): void {
		this.on('Schema.getDomains', () => ({
			domains: [
				'Runtime', 'Debugger', 'Console', 'Network', 'Fetch',
				'Target', 'Schema', 'Log', 'Profiler', 'HeapProfiler',
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
		this.noop('HeapProfiler.collectGarbage')
		this.noop('HeapProfiler.startTrackingHeapObjects')
		this.noop('HeapProfiler.stopTrackingHeapObjects')
		this.noop('HeapProfiler.takeHeapSnapshot')
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
