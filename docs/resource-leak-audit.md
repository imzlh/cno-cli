# HTTP resource lifetime audit

The 2026-10-04 audit found remaining C and TypeScript lifetime bugs even though
earlier keep-alive listener and H1 body-queue fixes were already present. The
original application's 10 MB to 200 MB incident was not available to reproduce;
the findings below were reproduced independently.

## Fixes and evidence

| Path | Failure | Reproduction and result |
| --- | --- | --- |
| `circu.js/src/mod_streams.c` | A synchronous promise hook starting a read during connect settlement left the connect pin outstanding. | Ten closed TCP objects, each retaining 1 MiB, survived GC before the fix. After rebuilding, all ten were collected; an active read still kept its object alive until close. |
| `cno/src/node/_internal/server-request-stream.ts` | The body pump ignored `push(false)` and moved the bounded H1 queue into an unbounded Node request buffer. | An unread 32 MiB POST buffered all 32 MiB before the fix and 16 KiB after it. Slow consumers retain every byte, and untouched bodies drain after the response so keep-alive can continue. |
| `http/src/h1.ts`, `http/src/server.ts` | Disconnect did not notify response waiters promptly; the request deadline ended at the headers, allowing paused uploads to retain connections indefinitely. | Disconnect now notifies the owner. The configured request timeout covers body reception and releases a stalled reader even when socket backpressure prevents observing EOF. Complete-body response work is excluded; zero still disables the deadline. |
| `cno/src/node/async_hooks/mod.ts` | Canceling a global timer through a numeric ID, `node:timers`, `close()`, or disposal could leave its async context in a strong map. | Each batch of 128 canceled timers with 64 KiB ALS stores retained about 8.55 MB before the fix. Four batches after the fix grew the VM by 104, 0, 0, and 0 bytes after GC. Refresh and interval cancellation are covered. |
| `http/src/socket.ts` | TLS input failure cleared the error callback before invoking it, preventing the protocol owner from closing its connection. | The error callback now runs after detaching the reader and can release the socket and TLS session. |

The pre-existing response adapter cleanup removes its per-response `close`
listener on completion or failure. The Node response also detaches its socket
after finishing. Their existing keep-alive tests passed in this audit.

## Regression tests

After rebuilding and refreshing the polyfill cache, run:

```sh
build/stage/cno setup
build/stage/cno test tests/node/native-streams-lifetime.test.ts \
  tests/node/http-request-backpressure.test.ts \
  tests/node/async-hooks-timer-cleanup.test.ts \
  tests/cts/http-socket-cleanup.test.ts
```

These files contain 16 new cases. Related validation covers HTTP incoming
messages and response adapters, H1 truncation and body limits, native socket
lifetime, timers, promise hooks, HTTPS, and server frameworks.

## Load measurements

A separate Node client drove ten concurrent connections to an Express 5 server:
200 warm-up GETs, two batches of 3,000 keep-alive GETs, 2,000 new-connection GETs,
and 1,000 JSON POSTs with 16 KiB bodies. The server forced GC only at sample
boundaries to measure retained allocations. The final source-path run recorded:

| Sample | VM bytes | JS objects | RSS bytes |
| --- | ---: | ---: | ---: |
| Warm-up | 14,181,448 | 21,971 | 53,047,296 |
| First 3,000 keep-alive requests | 14,181,481 | 21,971 | 55,525,376 |
| Second 3,000 keep-alive requests | 14,181,545 | 21,971 | 55,435,264 |
| All 9,200 requests, connections settled | 13,583,026 | 21,481 | 51,052,544 |

Ordinary completed requests did not show linear retained growth in this run.
These measurements do not cover application middleware retaining requests or
every possible workload. RSS without forced GC was higher; RSS alone does not
measure live objects.

## Build and validation environment

The initial native validation used GCC in WSL with QuickJS debug assertions
enabled. Its test build reused the existing CLI bytecode blob; TypeScript HTTP
changes were separately tested from current sources with an isolated cache and
a current-core preload.

After MSVC was reinstalled on 2026-10-04, a complete Windows Release build of
the current C and TypeScript sources succeeded with MSVC 19.51.36260 and the
Windows 10.0.26100.0 SDK. Dependencies were recovered from the existing vcpkg
binary cache into `build/msvc-deps/x64-windows`. The new build directory is
`build/windows-msvc`; the older top-level build cache still references E:.
The verified executable and required DLLs were copied to `build/stage` and
`dist/exe`. Previous staged files are backed up in
`build/windows-msvc/previous-stage`.

All 16 new regression cases, Express/Koa/Fastify tests, and net lifecycle tests
passed against this Windows binary without a source preload (6 test files).
Root `pnpm run type-check` also passed. The initial audit's seven existing ALS
asynchronous-propagation failures were independently reproduced with the
original `async_hooks` source; that separate compatibility issue was not
included in the passing claims.
