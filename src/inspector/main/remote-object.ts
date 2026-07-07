/**
 * inspector/main/remote-object.ts — CDP value serialization (main thread only).
 *
 * Turns live JS values into CDP RemoteObjects, minting objectIds through an
 * ObjectStore. The worker only ever sees the resulting JSON. Object identity /
 * lifetime is delegated to ObjectStore; this file is the "shape" half of the
 * old monolithic Serializer.
 *
 * All inputs are `unknown` (genuinely arbitrary user values) and narrowed via
 * `typeof` / structural casts — no `any` leaks into the rest of the codebase.
 */

import { ObjectStore } from './object-store';
import type {
	GetPropertiesResponse,
	ObjectPreview,
	PropertyDescriptor,
	PropertyPreview,
	RemoteObject,
	RemoteObjectSubtype,
	RemoteObjectType,
} from '../shared/cdp';

const MAX_PREVIEW_PROPS = 5;
const MAX_STR = 100;
type InspectableFunction = object & { name?: string };
const MAX_PROPS = 500; // cap getProperties to avoid oversized WS frames

/** Index access helper that never throws on primitives. */
type Indexable = Record<PropertyKey, unknown>;

export class Serializer {
	constructor(private store: ObjectStore = new ObjectStore()) {}

	// ── object-store delegation ───────────────────────────────────────
	add(value: unknown, group = 'default'): string { return this.store.add(value, group); }
	resolve(objectId: string): unknown { return this.store.resolve(objectId); }
	has(objectId: string): boolean { return this.store.has(objectId); }
	groupOf(objectId: string): string | undefined { return this.store.groupOf(objectId); }
	release(objectId: string): void { this.store.release(objectId); }
	releaseGroup(group: string): void { this.store.releaseGroup(group); }

	// ── serialization ────────────────────────────────────────────
	serialize(value: unknown, group = 'default', opts: { preview?: boolean } = {}): RemoteObject {
		switch (typeof value) {
			case 'undefined': return { type: 'undefined' };
			case 'boolean':   return { type: 'boolean', value };
			case 'string':    return { type: 'string', value };
			case 'symbol':    return { type: 'symbol', description: safeString(value), objectId: this.add(value, group) };
			case 'bigint':    return { type: 'bigint', unserializableValue: `${value}n`, description: `${value}n` };
			case 'number':    return serializeNumber(value);
			case 'function':  return { type: 'function', className: 'Function', description: safeFnString(value), objectId: this.add(value, group) };
			default: break; // 'object'
		}
		if (value === null) return { type: 'object', subtype: 'null', value: null };

		const subtype = objectSubtype(value);
		const className = classNameOf(value);
		const description = describeObject(value, subtype, className);
		const ro: RemoteObject = { type: 'object', className, description, objectId: this.add(value, group) };
		if (subtype) ro.subtype = subtype;
		if (opts.preview) ro.preview = this.buildPreview(value, subtype, description);
		return ro;
	}

	buildPreview(value: unknown, subtype?: RemoteObjectSubtype, description?: string): ObjectPreview {
		const sub = subtype ?? objectSubtype(value);
		const desc = description ?? describeObject(value, sub, classNameOf(value));
		const preview: ObjectPreview = { type: 'object', subtype: sub, description: desc, overflow: false, properties: [] };

		if (sub === 'error') {
			appendErrorPreview(preview, value);
			return preview;
		}

		if (sub === 'map' || sub === 'set') {
			preview.entries = [];
			let n = 0;
			try {
				if (sub === 'map') {
					for (const [k, v] of value as Map<unknown, unknown>) {
						if (n++ >= MAX_PREVIEW_PROPS) {
							preview.overflow = true;
							break;
						}
						preview.entries.push({ key: this.buildPreview(k), value: this.buildPreview(v) });
					}
				} else {
					for (const v of value as Set<unknown>) {
						if (n++ >= MAX_PREVIEW_PROPS) {
							preview.overflow = true;
							break;
						}
						preview.entries.push({ value: this.buildPreview(v) });
					}
				}
			} catch {}
			return preview;
		}

			let keys: string[] = [];
			if (!value || (typeof value !== 'object' && typeof value !== 'function')) return preview;
			keys = safeObjectKeys(value);
			/* Object.keys only returns own enumerable properties, but most
			 * built-in objects (Response, Request, URL, etc.) store their
			 * interesting properties as getters on the prototype. Walk one
			 * level up the chain to surface those in the preview too. */
			if (keys.length === 0) {
				keys = safePrototypePropertyNames(value);
			}
				for (let i = 0; i < keys.length; i++) {
					if (i >= MAX_PREVIEW_PROPS) {
						preview.overflow = true;
						break;
					}
					const k = keys[i];
					if (k === undefined) continue;
				const prop = safePropertyValue(value, k);
				if (!prop.ok) continue;
				const v = prop.value;
				preview.properties.push(previewProp(k, v));
			}
			return preview;
	}

	getProperties(objectId: string, group = 'default'): GetPropertiesResponse {
			const obj = this.resolve(objectId);
			const out: PropertyDescriptor[] = [];
			if (obj === undefined || obj === null) return { result: out };
			const names = safeOwnPropertyNames(obj);
			for (const name of names) {
				if (out.length >= MAX_PROPS) break;
				const d = safeOwnPropertyDescriptor(obj, name);
				if (!d) continue;
				const pd: PropertyDescriptor = { name, configurable: !!d.configurable, enumerable: !!d.enumerable, isOwn: true };
			if ('value' in d) {
				pd.value = this.serialize(d.value, group);
				pd.writable = !!d.writable;
			} else {
				if (d.get) pd.get = this.serialize(d.get, group);
				if (d.set) pd.set = this.serialize(d.set, group);
			}
			out.push(pd);
		}
		return { result: out };
	}
}

type PropertyDescriptorRaw = TypedPropertyDescriptor<unknown> & { value?: unknown; writable?: boolean };

// ── helpers ─────────────────────────────────────────────────────
function serializeNumber(value: number): RemoteObject {
	if (Number.isNaN(value)) return { type: 'number', unserializableValue: 'NaN', description: 'NaN' };
	if (value === Infinity)  return { type: 'number', unserializableValue: 'Infinity', description: 'Infinity' };
	if (value === -Infinity) return { type: 'number', unserializableValue: '-Infinity', description: '-Infinity' };
	if (Object.is(value, -0)) return { type: 'number', unserializableValue: '-0', description: '0' };
	return { type: 'number', value, description: String(value) };
}

function safeString(v: unknown): string {
	try {
		return String(v);
	} catch {
		return '<unprintable>';
	}
}

function safeFnString(fn: InspectableFunction): string {
	try {
		const s = Function.prototype.toString.call(fn);
		return s.length > 200 ? s.slice(0, 200) + '…' : s;
	} catch {
		return `function ${fn.name || ''}() { … }`;
	}
}

function objectSubtype(value: unknown): RemoteObjectSubtype | undefined {
	if (Array.isArray(value)) return 'array';
	if (value instanceof Error) return 'error';
	if (value instanceof RegExp) return 'regexp';
	if (value instanceof Date) return 'date';
	if (value instanceof Map) return 'map';
	if (value instanceof Set) return 'set';
	if (typeof WeakMap !== 'undefined' && value instanceof WeakMap) return 'weakmap';
	if (typeof WeakSet !== 'undefined' && value instanceof WeakSet) return 'weakset';
	if (value instanceof Promise) return 'promise';
	if (typeof ArrayBuffer !== 'undefined' && ArrayBuffer.isView(value)) return 'typedarray';
	if (typeof ArrayBuffer !== 'undefined' && value instanceof ArrayBuffer) return 'arraybuffer';
	return undefined;
}

function classNameOf(value: unknown): string {
	try {
		const ctor = value && (typeof value === 'object' || typeof value === 'function')
			? Reflect.get(value, 'constructor')
			: undefined;
		const c = ctor && (typeof ctor === 'object' || typeof ctor === 'function')
			? Reflect.get(ctor, 'name')
			: undefined;
		if (c) return c;
	} catch {}
	return safeClassTag(value);
}

function safeObjectKeys(value: object): string[] {
	try {
		return Object.keys(value);
	} catch {
		return [];
	}
}

function safePrototypePropertyNames(value: object | Function): string[] {
	try {
		const proto = Object.getPrototypeOf(value);
		if (!proto || proto === Object.prototype) return [];
		return Object.getOwnPropertyNames(proto).filter(
			k => k !== 'constructor' && k !== '__proto__' && k !== 'prototype'
		);
	} catch {
		return [];
	}
}

function safePropertyValue(value: object | Function, key: string): { ok: true; value: unknown } | { ok: false } {
	try {
		return { ok: true, value: (value as Indexable)[key] };
	} catch {
		return { ok: false };
	}
}

function safeOwnPropertyNames(value: unknown): string[] {
	try {
		return Object.getOwnPropertyNames(value);
	} catch {
		return [];
	}
}

function safeOwnPropertyDescriptor(value: unknown, name: string): PropertyDescriptorRaw | undefined {
	try {
		return Object.getOwnPropertyDescriptor(value, name);
	} catch {
		return undefined;
	}
}

function safeClassTag(value: unknown): string {
	try {
		return Object.prototype.toString.call(value).slice(8, -1);
	} catch {
		return 'Object';
	}
}

function describeObject(value: unknown, subtype: RemoteObjectSubtype | undefined, className: string): string {
	try {
		if (subtype === 'array' && Array.isArray(value)) return `${className}(${value.length})`;
		if (typeof ArrayBuffer !== 'undefined' && ArrayBuffer.isView(value)) return `${className}(${value.byteLength})`;
		if (subtype === 'error' && value instanceof Error) return describeError(value, className);
		if (subtype === 'regexp') return String(value);
		if (subtype === 'date') return (value as Date).toString();
		if (subtype === 'map' || subtype === 'set') {
			const size = value && typeof value === 'object' ? Reflect.get(value, 'size') : undefined;
			return `${className}(${typeof size === 'number' ? size : 0})`;
		}
	} catch {}
	return className;
}

function describeError(error: Error, className: string): string {
	const title = errorTitle(error, className);
	const stack = typeof error.stack === 'string' ? error.stack.trim() : '';
	if (!stack) return title;
	return stack.startsWith(title) ? stack : `${title}\n${stack}`;
}

function errorTitle(error: Error, className: string): string {
	const name = safeString(error.name || className || 'Error');
	const message = typeof error.message === 'string' ? error.message : safeString(error.message);
	return message ? `${name}: ${message}` : name;
}

function previewProp(name: string, v: unknown): PropertyPreview {
	const t = typeof v;
	if (v === null) return { name, type: 'object', subtype: 'null', value: 'null' };
	if (t === 'object') {
		const sub = objectSubtype(v);
		return { name, type: 'object', subtype: sub, value: abbreviate(v, sub) };
	}
	if (t === 'function') return { name, type: 'function', value: '' };
	if (typeof v === 'string') return { name, type: 'string', value: v.length > MAX_STR ? v.slice(0, MAX_STR) + '…' : v };
	return { name, type: t as RemoteObjectType, value: safeString(v) };
}

function abbreviate(v: unknown, subtype?: RemoteObjectSubtype): string {
	try {
		if (subtype === 'array' && Array.isArray(v)) return `Array(${v.length})`;
		return classNameOf(v);
	} catch { return 'Object'; }
}

function appendErrorPreview(preview: ObjectPreview, value: unknown): void {
	if (!(value instanceof Error)) return;
	const error = value;
	const props: PropertyPreview[] = [];
	props.push({ name: 'name', type: 'string', value: safeString(error.name || 'Error') });
	if (typeof error.message === 'string' && error.message) {
		props.push({ name: 'message', type: 'string', value: truncatePreviewString(error.message) });
	}
	if (typeof error.stack === 'string' && error.stack) {
		props.push({ name: 'stack', type: 'string', value: truncatePreviewString(error.stack) });
	}
	const cause = Reflect.get(error, 'cause');
	if (cause !== undefined) {
		if (cause === null) {
			props.push({ name: 'cause', type: 'object', subtype: 'null', value: 'null' });
		} else if (typeof cause === 'object') {
			const subtype = objectSubtype(cause);
			props.push({ name: 'cause', type: 'object', subtype, value: abbreviate(cause, subtype) });
		} else if (typeof cause === 'function') {
			props.push({ name: 'cause', type: 'function', value: '' });
		} else {
			props.push({ name: 'cause', type: typeof cause as RemoteObjectType, value: truncatePreviewString(safeString(cause)) });
		}
	}
	preview.properties = props.slice(0, MAX_PREVIEW_PROPS);
	preview.overflow = props.length > MAX_PREVIEW_PROPS;
}

function truncatePreviewString(value: string): string {
	return value.length > MAX_STR ? value.slice(0, MAX_STR) + '...' : value;
}
