/**
 * Minimal ambients for the node builtins the CDP inspector tests import.
 *
 * Full `@types/node` is intentionally not loaded project-wide (its web globals
 * clash with cno's webapi polyfills — see cno/src/type/lib.node-ambient.d.ts), and
 * nothing else in the tree declares `node:*` modules. Without these, type-checking
 * these test files reports only "cannot find name 'node:assert'" and the real
 * contract errors they exist to catch are buried.
 *
 * Deliberately narrow: only the members these tests actually use. This is a
 * type-checking aid, never loaded or emitted at runtime.
 */

declare module 'node:assert' {
	export function ok(value: unknown, message?: string): asserts value;
	export function strictEqual<T>(actual: unknown, expected: T, message?: string): asserts actual is T;
	export function rejects(
		block: (() => Promise<unknown>) | Promise<unknown>,
		error?: RegExp | Error | ((e: unknown) => boolean),
		message?: string,
	): Promise<void>;
}

declare module 'node:net' {
	interface Socket {
		write(data: string | Uint8Array): boolean;
		destroy(): void;
		on(event: 'data', listener: (chunk: Uint8Array | string) => void): Socket;
		on(event: 'error', listener: (err: Error) => void): Socket;
		on(event: 'close', listener: () => void): Socket;
		on(event: string, listener: (...args: never[]) => void): Socket;
	}
	export function connect(options: { host?: string; port: number }, connectListener?: () => void): Socket;
	export type { Socket };
}
