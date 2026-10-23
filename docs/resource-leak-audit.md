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

## Streaming proxy follow-up (2026-10-19)

The HTTP/1 streaming proxy path had another reproducible lifetime bug:
`Deno.serve` only canceled a response reader when a body write failed. If the
upstream sent a first SSE chunk and then became idle, the adapter waited in
`reader.read()` after the downstream client had disconnected. The upstream
fetch and its connection-pool slot stayed alive. Eight such requests filled the
per-host fetch pool; later requests timed out waiting for a slot.

The response adapter now subscribes to terminal transport close and cancels its
reader immediately. Header-write failure also cancels the response body, and a
HEAD response discards its unused body. An incoming Request now carries a
transport-linked AbortSignal, allowing `fetch(upstream, { signal: request.signal })`
to cancel before the upstream has returned response headers. HTTP/2 response
streams expose the same removable close subscription.

The staged binary was rebuilt from the current TypeScript sources. Five new
cases in `tests/deno/serve-stream-cleanup.test.ts` pass; the original staged
binary failed all four cases that were tested before the patch. The related
serve, HTTP lifecycle, fetch, and terminal-stream tests pass (eight files in
total). The TLS HTTP/2 round-trip is skipped because this build does not embed
the HTTP/2 extension. `pnpm run type-check` passes.

A separate Node upstream/client drove the Hono diagnostic fixture:

| Workload | Result |
| --- | --- |
| 20 idle-upstream cancellations, four concurrent direct proxy requests | 20 canceled, zero failed; upstream active requests returned to zero in 971 ms. |
| 20 idle-upstream cancellations through Hono `stream.pipe` | 20 canceled, zero failed; upstream active requests returned to zero in 1,180 ms. |
| 20 subsequent completed 1 MiB direct responses | 20 completed, zero failed, proving fetch-pool reuse after cancellation. |
| 12 slow 1 MiB `stream.pipe` responses, four concurrent requests | 12 completed, zero failed; VM after GC was 7.46 MB versus 7.33 MB before the workload. |
| Four cancellations before headers, with a 2,000 ms upstream header delay | Four canceled; all four upstream requests were observed and released. |

A 60-second CDP sample with GC every two seconds settled at 6.99 MiB of VM
memory, 10,476 objects and one native handle. The sample is saved under the
ignored build directory as `build/stream-proxy-postfix-memory.jsonl`. The
reproduction instructions are in `scripts/diagnostics/README.md`.

### Compressed-response limitation

Automatic libcurl decompression can still produce a large memory burst when
receiving is paused. A 32 MiB repeated-character gzip response occupied only
32,636 bytes on the wire, but an idle public fetch retained about 17 MB beyond
its baseline despite a 256 KiB stream high-water mark. Canceling the body
returned VM memory to its baseline. This is separate from the retained idle
upstream fixed above.

The [libcurl pause documentation](https://curl.se/libcurl/c/curl_easy_pause.html)
explains that libcurl continues decompressing the current downloaded chunk and
caches its expanded data when reception is paused. Returning
`CURL_WRITEFUNC_PAUSE` would move those bytes into libcurl's buffer and would not
by itself solve process-memory growth. Compare the workload with an explicit
`Accept-Encoding: identity` upstream header to identify this contribution.
No native decompression change is included in this follow-up.
