# Polyfills

The `cno/` directory provides the compatibility layer loaded before user code.
It installs Web APIs, Deno APIs, Node.js modules, and CNO-specific APIs.

## Bootstrap

`cno/src/main.ts` imports:

```text
cno/src/webapi/index.ts
cno/src/deno/index.ts
cno/src/cno/index.ts
cno/src/node/_internal/inject.ts
```

The CLI imports this bootstrap from `src/main.ts`.

## Web API

Web API implementations live under `cno/src/webapi/`.

Major surfaces:

- events and `EventTarget`
- timers and microtasks
- `URL`, `URLSearchParams`, `URLPattern`
- `TextEncoder`, `TextDecoder`
- `Blob`, `File`, `FormData`
- streams
- fetch, `Request`, `Response`, `Headers`, XHR
- `WebSocket`, EventSource, WebTransport-related APIs
- `crypto` and `crypto.subtle`
- `performance`
- `navigator`
- storage and Cache API pieces
- WebAssembly helpers

`cno/src/webapi/fetch/` owns Web fetch shapes. Raw HTTP/protocol helpers should
stay in `http/`.

## Deno API

Deno APIs live under `cno/src/deno/`.

| File | Area |
| --- | --- |
| `00_permission.ts` | Permission compatibility surface |
| `01_errors.ts` | `Deno.errors` |
| `02_fs.ts` | File system APIs |
| `03_fopen.ts` | File handles |
| `04_stdio.ts` | Standard streams |
| `05_net.ts` | TCP, TLS, Unix sockets, DNS |
| `06_process.ts` | `Deno.Command` and process APIs |
| `07_http.ts` | HTTP helpers |
| `08_serve.ts` | `Deno.serve` and websocket upgrade |
| `09_cron.ts` | Cron surface |
| `10_quic.ts` | QUIC integration |
| `ffi/` | FFI |
| `kv/` | KV store |

The permission model is compatibility-oriented. CLI permission flags are
accepted as no-ops where recognized.

## Node.js Modules

Node modules live under `cno/src/node/<name>/`. Most directories expose:

```text
mod.ts
index.ts
```

Implemented or partial areas include:

```text
assert, async_hooks, buffer, child_process, console, constants, crypto,
dgram, diagnostics_channel, dns, events, fs, http, http2, https, inspector,
ipc_channel, module, net, os, path, perf_hooks, process, punycode,
querystring, readline, repl, sqlite, sqlite3, stream, string_decoder, timers,
tls, tty, url, util, v8, vm, wasi, worker_threads, zlib
```

Shared Node internals live under:

```text
cno/src/node/_internal/
```

Examples:

- errno conversion
- HTTP client/server helpers
- server request parser/runtime/stream helpers
- upgrade handling
- buffer helpers
- structured clone helpers
- network debug hooks

## Node Global Injection

`cno/src/node/_internal/inject.ts` installs lazy global getters:

```text
process
Buffer
```

It also attaches an internal `__cno` object to the native `http` module for
Node HTTP server integration.

## Node Polyfill Installation

CTS resolves `node:` builtins from:

```text
<cacheDir>/node
```

`cno setup` populates that directory. In a development checkout, it copies from
local `cno/src/node` when available:

```sh
build/stage/cno setup
```

If no local source is found, setup can fetch source files from the upstream
GitHub path.

## CNO Namespace

CNO-specific APIs live under `cno/src/cno/` and are installed by
`cno/src/cno/index.ts`.

Current areas include:

- engine helpers
- pty
- SSL helpers
- compression helpers
- llhttp helpers

These are runtime-specific APIs and should not be described as Web, Deno, or
Node compatibility APIs.

## Maintenance Guidelines

- Keep compatibility behavior in the relevant layer: Web API, Deno, Node, or
  CNO namespace.
- Prefer shared Node internals only when multiple Node modules need the same
  behavior.
- Keep Node module code inside `cno/src/node/` unless a deliberate shared
  boundary exists.
- Use `import.meta.use()` for native modules in source.
- If runtime behavior changes, check related TypeScript declarations and tests.
