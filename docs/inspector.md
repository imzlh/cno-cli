# Inspector

The inspector implements a Chrome DevTools Protocol-compatible debugging
surface for `cno`.

User-facing flags:

```sh
--inspect[=host:port]
--inspect-brk[=host:port]
--inspect-wait[=host:port]
```

## Attach Timing

`src/commands/run.ts` attaches the inspector before creating the CTS runtime.
This matters because the inspector needs to wrap module lifecycle hooks before
CTS installs its own `engine.onModule()` handler.

```text
parse inspect flags
  -> create Inspector
  -> attach
  -> createRuntime
  -> add script init hook
  -> load entry
```

## Directory Layout

| Path | Role |
| --- | --- |
| `../src/inspector/index.ts` | Public inspector composition entry |
| `../src/inspector/main/` | Main-thread state, object store, pause controller, RPC handlers |
| `../src/inspector/worker/` | Debug worker, WebSocket server, CDP dispatcher |
| `../src/inspector/transport/` | Main/worker endpoints and message transports |
| `../src/inspector/domains/` | CDP domain implementations |
| `../src/inspector/shared/` | Protocol types, wire messages, RPC contract |
| `../circu.js/src/mod_debug.c` | Native debug hooks |

## Main And Worker Split

The inspector uses a worker to host the WebSocket/CDP server while the main
runtime owns execution state.

```text
DevTools
  <-> worker WebSocket server
  <-> worker CDP dispatcher
  <-> transport/RPC
  <-> main Inspector state
  <-> native debug hooks
```

## CDP Domains

Domain implementations live in `src/inspector/domains/`.

Important domains:

- `DebuggerDomain`: breakpoints, pause, resume, stepping, script events
- `RuntimeDomain`: evaluate, callFunctionOn, object inspection
- `ConsoleDomain`: console message buffering and forwarding
- `NetworkDomain`: fetch/serve/WebSocket network events
- `FetchDomain`: request interception surface
- `PageDomain`: page/frame lifecycle events
- `TargetDomain`: target discovery and attachment behavior

## Object Lifetime

Remote objects are stored and released by object group. Paused-scope objects
need to remain valid while execution is paused and be released when the runtime
resumes.

When changing pause/resume behavior, check both:

- domain state transitions in `DebuggerDomain`
- object store lifetime in the main inspector state

## Discovery Surface

The debug worker serves `/json` discovery endpoints and WebSocket targets.
Discovery semantics are separate from whether WebSocket attach works. If a test
or frontend cares about target `type`, `url`, or WebSocket URL shape, inspect
the worker server and target domain together.

## Task Re-entry

Flags like `--inspect-wait` can cross command shortcuts such as `cno run task`.
If inspector behavior disappears across task execution, inspect:

```text
src/main.ts
src/commands/inspect.ts
src/commands/task.ts
cts/src/task.ts
```

before changing transport or domain code.

## Validation

Focused validation usually combines:

```sh
pnpm run type-check
build/stage/cno setup
build/stage/cno test tests/node/inspect-flags.test.ts
build/stage/cno test tests/node/inspector.test.ts
```

Add more CDP-specific tests when changing protocol payloads, paused object
lifetime, or discovery behavior.
