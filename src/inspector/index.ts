/**
 * CDP inspector for the cno runtime: the main thread executes and inspects, a
 * worker thread runs the DevTools WebSocket server (CDP ↔ internal RPC).
 * Public surface consumed by commands/run.ts and the REPL.
 */

export { Inspector, type InspectorOptions } from './main/inspector'
