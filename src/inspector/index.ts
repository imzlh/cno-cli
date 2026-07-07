/**
 * inspector — a CDP (Chrome DevTools Protocol) inspector for the cno runtime.
 *
 * Architecture: the main thread owns execution + inspection; a worker thread
 * runs the DevTools WebSocket server and translates CDP ↔ the internal RPC.
 *
 * Public surface consumed by commands/run.ts and the REPL.
 */

export { Inspector, type InspectorOptions } from './main/inspector'
