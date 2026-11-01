/**
 * The CLI's evbus value channels.
 *
 * The CLI publishes process-wide configuration under the `cno.runtime`
 * namespace for cno and cts to read; consumers declare the matching string
 * constants on their side. The evbus native module ships with the pinned
 * circu.js core, so access is a hard requirement — only a missing *value* is
 * graceful. Each worker has its own bus, so publications stay realm-scoped.
 */

const evbus = import.meta.use('evbus');

export const RUNTIME_CHANNEL_NAMESPACE = 'cno.runtime';

export const CHANNEL_REQUEST_EXIT_CODE = 'requestExitCode';
export const CHANNEL_MAIN_SCRIPT = 'mainScript';
export const CHANNEL_WORKER_RUNTIME_CONFIG = 'workerRuntimeConfig';
export const CHANNEL_BLOB_URL_RESOLVER = 'blobUrlResolver';

/** Publish (or replace) one CLI-owned runtime value. */
export function publishChannel<T>(key: string, value: T): void {
    evbus.set(RUNTIME_CHANNEL_NAMESPACE, key, value);
}

/** Read one runtime value; `undefined` when this runtime never published it. */
export function readChannel<T>(key: string): T | undefined {
    return evbus.get<T>(RUNTIME_CHANNEL_NAMESPACE, key);
}
