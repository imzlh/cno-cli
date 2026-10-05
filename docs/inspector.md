# Inspector

The inspector implements a Chrome DevTools Protocol-compatible debugging
surface for `cno`.

Place Inspector options before the command:

```sh
cno --inspect[=host:port] run app.ts
cno --inspect-brk[=host:port] eval "code"
cno --inspect-wait[=host:port] test tests/
```

The CLI retains Inspector options in the command region without activating them.
Tokens after the entry are script arguments.

## Attach Timing

`src/inspector/options.ts` interprets normalized core options.
`src/kernel.ts` owns attachment for commands that execute code, before creating
the CTS runtime. This ordering lets the Inspector wrap module lifecycle hooks
before CTS installs its own `engine.onModule()` handler.

```text
prepareKernel / inspectOptions
  -> create Inspector
  -> attach
  -> createRuntime
  -> install bridge and runtime init hook
  -> load entry
```

## Directory Layout

| Path | Role |
| --- | --- |
| `../src/kernel.ts` | Runtime session, Inspector attachment and lifetime |
| `../src/inspector/options.ts` | Core Inspector option and address validation |
| `../src/inspector/bridge.ts` | Runtime bridge for opening, closing, and querying the Inspector |
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

## Runtime And Bridge Lifetime

The kernel session separates completion of entry evaluation from terminal
teardown. `finish()` marks evaluation complete and calls `allowProcessExit()`;
it does not remove the bridge or destroy the runtime. Timers and other pending
work can continue using `node:inspector`, and an Inspector opened after
`finish()` is also allowed to stop keeping the process alive.

The runtime installs one init hook that consults the current Inspector. Closing
and reopening the Inspector therefore does not accumulate hooks or retain a
previous Inspector's callback. Bridge `close()` detaches the current Inspector
while permitting a later open; terminal `dispose()` also removes that bridge
and prevents new opens. Removing an older bridge does not remove a newer
session's bridge.

`KernelRuntime.close()` shares one promise across repeated calls. It disposes the
bridge and releases runtime resources even when detachment fails. Failed
construction or initialization closes the partial session and preserves the
original failure. `run` and `eval` call `finish()` after evaluation; the REPL
calls `close()` when its session ends.

CLI process cleanup is registered at native `EV.EXIT`, after user exit/unload
handlers, rather than at the end of entry evaluation. The preceding
`EV.BEFORE_EXIT` synchronizes the native exit status without starting an exit
poll or stopping pending work.

## Discovery Surface

The debug worker serves `/json` discovery endpoints and WebSocket targets.
Discovery semantics are separate from whether WebSocket attach works. If a test
or frontend cares about target `type`, `url`, or WebSocket URL shape, inspect
the worker server and target domain together.

## Task Re-entry

Prefix flags such as `--inspect-wait` cross command shortcuts such as
`cno --inspect-wait run task build` without promoting inactive command options.
If inspector behavior disappears across task execution, inspect:

```text
src/main.ts
src/inspector/options.ts
src/kernel.ts
src/commands/task.ts
cts/src/task.ts
```

before changing transport or domain code.

## Validation

Focused validation usually combines:

```sh
pnpm run type-check
cmake --build build
build/stage/cno test tests/cts/kernel-lifecycle.test.ts
build/stage/cno test tests/node/inspect-flags.test.ts
build/stage/cno test tests/node/inspector.test.ts
```

Add more CDP-specific tests when changing protocol payloads, paused object
lifetime, or discovery behavior.
