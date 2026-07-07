/**
 * inspector/main/object-store.ts — the main-thread object table.
 *
 * Holds *real* JavaScript references behind opaque `obj:N` ids and tracks them
 * by group so a whole group can be released at once (Runtime.releaseObjectGroup,
 * or automatically on resume). This is pure storage; turning a value into a CDP
 * RemoteObject lives in remote-object.ts.
 */

import { getMemoryTier } from '../../../cno/src/utils/memory-tier'

interface Entry { value: unknown; group: string }

const MAX_STORE_SIZE = { low: 1000, normal: 3000, high: 10000 }[getMemoryTier()] ?? 3000

export class ObjectStore {
	private objSeq = 0;
	private store = new Map<string, Entry>();
	private groups = new Map<string, Set<string>>();

	add(value: unknown, group = 'default'): string {
		if (this.store.size >= MAX_STORE_SIZE) this.evictOldest();
		const id = `obj:${++this.objSeq}`;
		this.store.set(id, { value, group });
		let g = this.groups.get(group);
		if (!g) {
			g = new Set<string>();
			this.groups.set(group, g);
		}
		g.add(id);
		return id;
	}

	resolve(objectId: string): unknown {
		return this.store.get(objectId)?.value;
	}

	has(objectId: string): boolean {
		return this.store.has(objectId);
	}

	groupOf(objectId: string): string | undefined {
		return this.store.get(objectId)?.group;
	}

	release(objectId: string): void {
		const e = this.store.get(objectId);
		if (!e) return;
		this.store.delete(objectId);
		this.groups.get(e.group)?.delete(objectId);
	}

	releaseGroup(group: string): void {
		const ids = this.groups.get(group);
		if (!ids) return;
		for (const id of ids) this.store.delete(id);
		this.groups.delete(group);
	}

	private evictOldest(): void {
		const oldest = this.store.keys().next().value;
		if (oldest !== undefined) this.release(oldest);
	}
}
