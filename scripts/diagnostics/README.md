# Streaming HTTP proxy memory diagnostics

The upstream server and the load client use Node.js (22 or newer recommended)
and run in separate processes; the proxy under test uses cno. The client
consumes the response chunk by chunk and never keeps the full response body.

Start the three terminals in order; all commands run from the repository root:

```powershell
node scripts/diagnostics/streaming-upstream.mjs --bytes 1048576 --delay-ms 1
```

```powershell
.\build\stage\cno.exe --no-lock --inspect=127.0.0.1:9229 run scripts/diagnostics/streaming-proxy.ts
```

```powershell
node scripts/diagnostics/streaming-load.mjs --url http://127.0.0.1:8787/direct --requests 100 --concurrency 4
```

The proxy is pinned to `hono@4.12.27`. `/direct` returns the fetched Response,
`/pipe` uses Hono's `stream().pipe()`, and `/plain` returns the fetched Response
directly from `Deno.serve`. Changing the route lets you compare the impact of
Hono, the stream API, and the HTTP implementation.

When testing against a real program, replace `--url` with the actual proxy
endpoint. `--timeout-ms` is the total time limit for a single request from start
to finish; slow streams need a correspondingly larger limit. The output is JSON
lines; the last line contains the completed, aborted, and failed counts, bytes
read, and elapsed time.

## Continuous CDP monitoring

In another terminal, connect to the process under test, which already has
`--inspect` enabled:

```powershell
node scripts/diagnostics/monitor-memory-cdp.mjs --inspect=http://127.0.0.1:9229 --interval=2000 --duration=120 --gc-every=10 --output=memory.jsonl
```

It samples every 2 seconds for 120 seconds, runs GC every 10 samples, and writes
to a newly created JSONL file. `--gc-every=0` disables manual GC; controlled
experiments can record natural GC and periodic manual GC separately. Monitoring
requires a newer cno that includes the `CNO.getMemoryUsage` extension; older
versions prompt you to rebuild. The JSONL contains baseline deltas, and GC
samples additionally include `afterGC` and the number of VM bytes reclaimed.

## Comparison scenarios

After each round, wait a few seconds before recording memory and confirm that
the upstream active connection count is back to 0. The first start loads
dependencies, compiles, and populates caches, so run one warm-up round first,
then compare several rounds under the same load.

Normal full read:

```powershell
node scripts/diagnostics/streaming-load.mjs --url http://127.0.0.1:8787/direct --requests 100 --concurrency 4
```

Slow client:

```powershell
node scripts/diagnostics/streaming-load.mjs --url http://127.0.0.1:8787/pipe --requests 40 --concurrency 4 --slow-ms 10 --timeout-ms 60000
```

The client disconnects after reading the first chunk; the upstream goes idle
after sending its first chunk until the client disconnects or the upstream
safety timeout (60 seconds by default) expires. This checks whether resources
are released promptly when a response read task is suspended:

```powershell
node scripts/diagnostics/streaming-load.mjs --url 'http://127.0.0.1:8787/direct?idle=1' --requests 20 --concurrency 4 --abort-after-bytes 1024 --timeout-ms 5000
Invoke-RestMethod 'http://127.0.0.1:8788/stats'
```

Expected load result: `aborted=20, failed=0`, upstream `active=0`. If requests
start timing out after the first 8 aborts, that usually means the process under
test still has its 8 per-host fetch connection slots occupied by idle upstreams.
Then run the normal full-read scenario again to check that the connection pool
still works.

Upstream parameters can be forwarded through the proxy URL, for example
`?bytes=33554432&chunk-bytes=16384&delay-ms=0`. `bytes` is the byte count per
response, `chunk-bytes` the byte count per chunk, and `delay-ms` the interval
between upstream chunks. The upstream serves 8 MiB per response by default; the
launch commands in this document set it to 1 MiB.

Disconnect before the upstream response headers have arrived:

```powershell
node scripts/diagnostics/streaming-load.mjs --url 'http://127.0.0.1:8787/direct?headers-delay-ms=2000' --requests 20 --concurrency 4 --abort-after-ms 100 --timeout-ms 5000
```

Large compressed upstream responses, to check that the decompressed data honors
the slow client's backpressure:

```powershell
node scripts/diagnostics/streaming-load.mjs --url 'http://127.0.0.1:8787/pipe?gzip=1&bytes=33554432&delay-ms=0' --requests 8 --concurrency 2 --slow-ms 20 --timeout-ms 120000
```

The upstream repeats characters to achieve a high compression ratio; `bytes` and
the upstream statistics' `bytes` refer to the pre-compression size. After the
proxy's fetch decompresses, the client should read 32 MiB per response. When
load-testing the Node upstream directly, the load generator reads the gzip
compressed bytes.

## Memory readings

The fixture provides `GET /memory`, which returns cno native memory counters;
`?gc=1` runs GC twice, leaving one event-loop turn in between.

```powershell
Invoke-RestMethod 'http://127.0.0.1:8787/memory?gc=1'
```

`os.rss` is the resident memory of the whole process, including native resources
and worker threads; `vm.used`, `used`, and `object.count` come from the
main-thread QuickJS. If these counters keep rising every round after GC, a
reference is more likely unreleased; if only RSS rises it may also include
native buffers, allocator caches, or other threads. `buffer.used` and
`buffer.count` describe serialized bytecode objects, not the total ArrayBuffer
amount.

These counters narrow the search; they do not provide a reference chain. CDP
monitoring can additionally inspect remote objects retained by the inspector,
request body buffers, and active streams.

## Verifying the diagnostic client

```powershell
node --test scripts/diagnostics/streaming-load.test.mjs
```

The tests cover full responses, slow reads, disconnect after the first chunk,
disconnect before the headers, compressed responses, idle response timeout, and
invalid upstream parameters. Stop a resident service with Ctrl+C.

## devid real-route regression

`devid/tests/proxy-memory-fixture.ts` in the adjacent directory uses real proxy
routes, avoiding source discovery and FFmpeg. First complete the cno build and
prepare the dependency cache, then run:

```powershell
node scripts/diagnostics/devid-memory-audit.mjs --devid ../devid --binary build/stage/cno.exe --cache build/audit-devid-20261023-cache --rounds 4 --output build/devid-memory-audit.jsonl
.\build\stage\cno.exe test tests/node/native-stream-read-oom.test.ts tests/webapi/abort-signal-lifetime.test.ts tests/webapi/finalization-registry-lifetime.test.ts
```

Under 32/64 MiB limits the load covers full reads, slow reads, disconnect before
headers, idle stream disconnect, segment forwarding, error responses, Range, and
HEAD. After each batch, wait for upstream active connections to return to zero,
then run GC and record VM memory and object counts; a residual growth above
64 KiB in any round fails. The low-memory read test forces eight OOMs inside a
TypeScript subprocess while checking callback errors, buffer release, reclamation
of read objects, and exit diagnostics.
