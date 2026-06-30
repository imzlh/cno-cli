# AGENT.md - cno-cli Project Guide for AI Agents

## Project Architecture Overview

cno-cli is a Deno-compatible TypeScript CLI runtime built on circu.js. The project consists of **6 core submodules** forming a complete TypeScript runtime ecosystem:

```
┌─────────────────────────────────────────────────────────────────┐
│                      cno-cli (CLI Entry)                        │
│   src/main.ts → CLI parse → dispatch to run/eval/repl/test      │
└─────────────────────────────────────────────────────────────────┘
                              │
        ┌─────────────────────┼─────────────────────┐
        ▼                     ▼                     ▼
┌───────────────┐   ┌─────────────────┐   ┌─────────────────┐
│      cts      │   │       cno       │   │  @cnojs/http    │
│  TS Loader    │   │  Polyfill Layer │   │  HTTP Protocol  │
└───────────────┘   └─────────────────┘   └─────────────────┘
        │                     │                     │
        └─────────────────────┼─────────────────────┘
                              ▼
                    ┌───────────────────┐
                    │     circu.js      │
                    │  Core Runtime     │
                    │ (QuickJS+libuv)   │
                    └───────────────────┘

CDP Inspector (Chrome DevTools Protocol):
┌─────────────────────────────────────────────────────────────────┐
│  DevTools (browser) ──WebSocket──▶ worker/server.ts             │
│     ◀── CDP ──▶ domains/*  ◀──RPC──▶ transport/*  ◀──▶ native  │
└─────────────────────────────────────────────────────────────────┘
```

---

## Before You Begin
THERE ARE SOME WARNINGS YOU SHOULD BE AWARE OF:
 - You are supposed to use `import.meta.use()` to load modules.
 - NEVER cast types uncausally, especially when using `import.meta.use()`.
 - When using `os.getenv`, which will throws when the environment variable is not set.
   Please trap the error using `try { ... } catch (e) { }` to avoid crashing.
 - If speed and no accuracy is required, use `engine.encode/decodeString` instead.
   Which is natively supported by QuickJS which is faster. (Only UTF8 decoding and encoding)
 - Reduce using global variables, use `import.meta.use()` low-level api instead.
   For example, `import.meta.use('text').Encoder` not `globalThis.TextEncoder`
 - If you are compressing context, never forget to remind yourself to read me again after compressing.
 - These warnings are edited by user, you should take into account more carefully.

## Code Style Guide
I prefer to use the following style for writing code:
```ts
/** top level comment, optional */
import type {} from '';
import * as xx from '';

const fs = import.meta.use('fs');   // NO CASTING

const {} = ...; // some pre-defined variables

const fn1 = () => void 0;       // if function is short, use arrow function
export default function () {}   // exports directly
```

## Module 1: circu.js — Core Runtime

**Location**: `circu.js/`  
**Language**: C (QuickJS + libuv)  
**Purpose**: Lightweight JavaScript runtime with ES2024+ engine and event loop

### Key Features
- **QuickJS**: ES2025+ JS engine (modules, Promise, Proxy, BigInt, async generators)
- **libuv**: Event loop, async I/O, threads, networking (cross-platform)
- **`import.meta.use()`**: Unique built-in module loading system (NOT standard `import`)
- **Self-attaching bytecode**: Compiled JS bytecode can be appended to binary

### Built-in Modules (`import.meta.use('name')`)

| Module | Description | Key APIs |
|--------|-------------|----------|
| `fs` | Sync file system | `readFile`, `writeFile`, `stat`, `readdir`, `mkdir`, `unlink` |
| `asyncfs` | Async file system | Same as fs but returns Promises, `FileHandle` class |
| `fswatch` | File watcher | inotify/FSEvents/ReadDirectoryChangesW |
| `os` | OS info | `cwd`, `env`, `pid`, `ppid`, `homedir`, `tmpdir`, `uname`, `memoryUsage` |
| `process` | Process mgmt | `spawn`, `exec`, `kill`, `wait` |
| `engine` | Runtime API | `eval`, `serialize`, `deserialize`, `gc`, `Module`, `onModule`, `promise_hook` |
| `crypto` | Cryptography | `md5`, `sha256`, `hmac`, `aes`, `rsa`, `ecdsa` |
| `http` | HTTP parser | llhttp-based request/response parsing |
| `ssl` | TLS/SSL | OpenSSL wrapper, `Context`, `Pipe` |
| `zlib` | Compression | `deflate`, `inflate`, `gzip`, `gunzip`, `brotli` |
| `ffi` | FFI | `UvLib`, `FfiCif`, `call` C functions from JS |
| `worker` | Workers | `Worker`, `MessagePipe`, thread spawning |
| `dns` | DNS | `resolve`, `resolveSync` with TTL cache |
| `streams` | Streams | `TCP`, `Pipe`, `TTY`, socket abstractions |
| `timers` | Timers | `setTimeout`, `setInterval`, `setImmediate` |
| `console` | Console | `log`, `error`, `warn`, `inspect` |
| `sqlite3` | SQLite | Full SQLite3 API |
| `xml` | XML parsing | expat-based parser |
| `sourcemap` | SourceMap | Parse and query source maps |
| `jsonc` | JSONC | Parse JSON with comments |
| `algorithm` | Utils | Sorting, binary search, encoding helpers |
| `text` | Text | iconv-based encoding conversion |
| `signals` | Signals | POSIX signal handling |
| `curl` | HTTP client | libcurl-based HTTP client (used by fetch) |
| `udp` | UDP | dgram/UDP socket support |
| `debug` | Debugging | Debugger support (used by CDP debugger) |
| `win32` | Windows | Windows-specific APIs |
| `nodeapi` | Native Layer | Node.js-compatible n-api bindings to use node native modules |

### Type Definitions
- `circu.js/types/*.d.ts` — TypeScript definitions for all modules

### Build Targets
- `cjs` — Runtime binary (CLI)
- `cjsc` — Bytecode compiler (for self-attaching)
- `libcjs` — Static library (for embedding)

### Engine Module Details (`import.meta.use('engine')`)
**Location**: `circu.js/types/engine.d.ts`

---

## Module 2: cts — TypeScript Loader

**Location**: `cts/`
**Language**: TypeScript
**Purpose**: Module resolution, TS transformation, multi-protocol support

### Architecture (4-Layer Design)

```
require('foo')  ─→  api/
import 'foo'    ─→  runtime/hooks.ts
                      │
                      ▼
                  resolve/          Find files → ModuleInfo
                      │
                      ▼
                  source/           Read + transform (format-agnostic)
                      │
                      ▼
                  compile/          Compile + cache + CJS↔ESM bridge
                      │
                      ▼
                  Module / exports
```

### Directory Structure

```
cts/src/
├── resolve/                    # Layer 1: find file paths
│   ├── index.ts                # ModuleResolver (3-level cache: L1 source→spec, L2 spec→info, L3 dispatch)
│   ├── builtins.ts             # BUILTINS Set + isBuiltinSpecifier()
│   ├── pkg.ts                  # package.json exports/imports resolution
│   └── protocols/              # Protocol handlers
│       ├── base.ts             # ProtocolHandler interface + guessFileKind
│       ├── file.ts             # file://
│       ├── npm.ts              # npm: registry resolution
│       ├── jsr.ts              # jsr: Deno registry
│       ├── http.ts             # http:/https: remote modules
│       ├── node.ts             # node: built-in polyfills
│       └── data.ts             # data: URLs (RFC 2397)
│
├── source/                     # Layer 2: read files + transform (CJS/ESM agnostic)
│   ├── index.ts                # readSource(), readSourceForCjs()
│   ├── transform.ts            # Transformer (OXC native primary, Sucrase fallback)
│   └── cache.ts                # JscCache L1(内存)+L2(磁盘) bytecode cache
│
├── compile/                    # Layer 3: compile + cache + bridge
│   ├── index.ts                # ModuleCompiler facade (orchestrates ESM/CJS/WASM)
│   ├── esm.ts                  # EsmCompiler: engine.Module compilation + esmCache + circular deps
│   ├── cjs.ts                  # CjsLoader: CJS exec, mkRequire factory, requireEsm, loadBuiltin
│   ├── wasm.ts                 # WasmCompiler: WASM loading + circular deps
│   ├── bridge.ts               # CJS↔ESM bridge: bridgeCjsToEsm, loadEsmSync (promiseResult), installGlobalRequire
│   └── builtins.ts             # (re-exports from resolve/builtins.ts)
│
├── api/                        # Layer 4: thin re-exports for external consumers
│   └── index.ts                # Re-exports CjsModule, ModuleCompiler, bridge functions, BUILTINS
│
├── runtime/                    # Composition root: lifecycle + engine hooks
│   ├── index.ts                # TypeScriptRuntime + createRuntime
│   ├── hooks.ts                # engine.onModule (resolve/load/init/attrchk) + loadedModules dedup
│   ├── meta.ts                 # import.meta population (url, filename, dirname, resolve)
│   └── resources.ts            # ResourceManager class (instance-based, not singleton)
│
├── utils/                      # Shared utilities
│   ├── index.ts                # Re-exports + uname/isWindows
│   ├── bin.ts                  # Binary resolution
│   ├── io.ts                   # File I/O with LRU resolution cache
│   ├── log.ts                  # Structured debug logger
│   ├── lru.ts                  # Bounded LRU cache
│   ├── misc.ts                 # Hash, semver, tar.gz, JSONC, arg parsing
│   ├── path.ts                 # Pure path utilities
│   ├── progress.ts             # Precache progress UI
│   └── tier.ts                 # Memory tier detection
│
├── types.ts                    # Shared types (ModuleInfo, RuntimeConfig, ConfigOptions, PackageJson)
├── config.ts                   # Config loading (CLI + env + tsconfig + deno.json + package.json)
├── deps.ts                     # DepScanner (BFS dependency scanning)
├── errors.ts                   # ErrorKind, TransformError, formatError, fatal
├── flow.ts                     # Generator-based I/O flow (runSync, runAsync, StepType)
├── lock.ts                     # SQLite3 lock store (sources, modules, bins tables)
├── oxc.ts                      # Native OXC extension loader
├── precompile.ts               # Worker-parallel transform + main-thread QJS compile
├── scan.ts                     # Import extraction (Sucrase tokenizer, used by workers)
├── shell.ts                    # Shell command parser
├── task.ts                     # deno.json/package.json task runner
└── wasm.ts                     # buildWasmModule helper
```

### Core Types (`cts/src/types.ts`)

```typescript
type ModuleFormat = 'esm' | 'cjs';
type FileKind = 'source' | 'json' | 'wasm' | 'binary' | 'text';

interface ModuleInfo {
    specPath: string;
    localPath: string;
    format: ModuleFormat;
    fileKind: FileKind;
}

interface ConfigOptions {
    cacheDir?: string;
    enableHttp?: boolean;
    enableJsr?: boolean;
    enableNode?: boolean;
    enableCache?: boolean;     // default: true (inverted from old disableCache)
    enableOxc?: boolean;
    silent?: boolean;
    disableLock?: boolean;     // renamed from noLock
    frozen?: boolean;
    lockDir?: string;
    polyfill?: string;
    // ... see types.ts for full list
}
```

### Module Resolution Flow (resolve/)

```
1. L1 Cache: lock.sources["mode\0spec\0parent"] → specPath
2. L2 Cache: lock.modules[specPath] → ModuleInfo
3. L3 Dispatch: protocol handler → download if needed
```

### ModuleCompiler Details (compile/index.ts)

```typescript
class ModuleCompiler {
    readonly esm: EsmCompiler;
    readonly cjs: CjsLoader;
    readonly wasm: WasmCompiler;

    constructor(resolver: ModuleResolver, cfg: RuntimeConfig);

    load(info: ModuleInfo, meta?: Record<string, any>): Module;
    loadSource(code: string, info: ModuleInfo, meta?: Record<string, any>): Module;
    preRegister(localPath: string, parentPath: string): void;
    requireInternal(id: string, parentPath?: string): any;
}
```

### ESM/CJS Interop Rules (compile/bridge.ts)

```
ESM imports CJS → module.exports becomes `default`; named keys also exported
ESM imports CJS with __esModule=true → treat as transpiled ESM
CJS requires ESM → loadEsmSync via engine.promiseResult:
  - throws → propagate (module error)
  - returns null → throw "cannot require() async ESM"
  - returns content → return mod.namespace (live reference, C++ native)
CJS requires CJS → normal require() chain
Circular CJS → return partial exports (Node.js behavior)
```

### TypeScriptRuntime Details (runtime/index.ts)

```typescript
class TypeScriptRuntime {
    resolver: ModuleResolver;
    compiler: ModuleCompiler;    // was `loader: ModuleLoader`
    config: RuntimeConfig;
    resources: ResourceManager;  // instance-based, not global singleton

    constructor(cfg: RuntimeConfig, entryDir?: string);

    async precache(entrySpecPath: string, entryLocalPath: string): Promise<ScanResult>;
    async loadPolyfill(path: string): Promise<void>;
    async loadEntry(path: string, extra?: Record<string, any>): Promise<Module>;

    registerNodeResolver(r: NodeBuiltinResolver): void;
    flushLock(): void;
    cleanup(): void;
}
```

### ResourceManager (runtime/resources.ts)

Instance-based (not singleton). Each TypeScriptRuntime creates its own.
Standard cleanups: connection pools, DNS cache, pkg cache, resolve cache.

```typescript
class ResourceManager {
    register(fn: Cleanup): void;
    release(): void;           // LIFO, idempotent
    get released(): boolean;
}
```

### Lock File Format (SQLite3)

LockStore uses SQLite3 (`cts.lock`) with tables:
- `sources` — spec→specPath mapping (L1 cache)
- `modules` — specPath→ModuleInfo (L2 cache)
- `bins` — binary name→local path

### CJS→ESM Sync Loading (compile/bridge.ts)

`loadEsmSync` uses `engine.promiseResult` with three outcomes:
1. **Throws** → module evaluation failed → propagate as CJS require error
2. **Returns null** → top-level await unresolved → throw "cannot require() async ESM"
3. **Returns content** → success → return `mod.namespace` (live reference)

IMPORTANT: Returns live namespace reference, NOT a shallow copy.
Module is C++ native; `export()` bindings live in C++ memory.
A shallow copy would create dangling pointers if the Module is GC'd.

### Config Loading Priority

```
1. CLI flags (highest)
2. Environment variables (CTS_*)
3. deno.json / deno.jsonc
4. tsconfig.json
5. package.json (imports field)
6. Defaults (lowest)
```

### Transform Diagnostics Convention

- `cts/src/source/transform.ts` is the boundary that converts OXC/Sucrase parse failures into structured diagnostics.
- When transform code has line and column information, throw `TransformError` from `cts/src/errors.ts` instead of flattening the error into a formatted string.
- `TransformError` must carry `fileName`, `line`, and `column` so REPL, CLI, and future editors can render code frames without parsing human text.
- Callers such as the REPL should treat transform diagnostics as structured data first, and only fall back to message parsing for backward compatibility.

---

## Module 3: cno — Polyfill Layer

**Location**: `cno/`  
**Language**: TypeScript  
**Purpose**: WebAPI + Deno + Node.js compatibility layer

### Directory Structure

```
cno/src/
├── main.ts           # Entry: imports webapi, deno, cno, node inject
├── webapi/           # Web API polyfills
│   ├── index.ts      # Entry: injects global objects
│   ├── url.ts        # URL, URLSearchParams
│   ├── websocket.ts  # WebSocket
│   ├── crypto.ts     # crypto.subtle (WebCrypto)
│   ├── performance.ts
│   ├── storage.ts    # localStorage, sessionStorage
│   ├── abort.ts      # AbortController, AbortSignal
│   ├── formdata.ts   # FormData, Blob, File
│   ├── streams.ts    # ReadableStream, WritableStream, TransformStream
│   ├── events.ts     # Event, CustomEvent, EventTarget
│   ├── messaging.ts  # MessageChannel, MessagePort
│   ├── worker.ts     # Worker
│   ├── broadcast-channel.ts
│   ├── intl.ts       # Intl (partial)
│   ├── wasm.ts       # WebAssembly
│   ├── basic.ts      # atob, btoa, queueMicrotask, structuredClone, timers
│   ├── cache.ts      # CacheStorage / Cache API
│   ├── location.ts   # location polyfill
│   ├── sse.ts        # EventSource / SSE
│   ├── webtransport.ts # WebTransport (QUIC)
│   ├── console/      # console with formatting
│   ├── fetch/        # fetch, Request, Response, XMLHttpRequest
│   │   ├── index.ts
│   │   ├── request.ts
│   │   ├── response.ts
│   │   ├── perform.ts  # curl-backed fetch implementation
│   │   ├── helpers.ts
│   │   └── xhr.ts    # XMLHttpRequest
│   └── navigator/    # navigator.userAgent, etc.
│       ├── index.ts  # NavigatorImpl
│       ├── core.ts   # NavigatorCoreImpl
│       ├── connection.ts # NetworkInformation
│       ├── permissions.ts # Permissions API
│       ├── sockets.ts # Direct Sockets
│       ├── storage.ts # StorageManager
│       └── types.ts
├── deno/             # Deno API
│   ├── index.ts      # Deno global object
│   ├── 00_permission.ts # Deno.Permissions polyfill
│   ├── 01_errors.ts  # Deno.errors
│   ├── 02_fs.ts      # Deno.readFile, writeFile, mkdir, etc.
│   ├── 03_fopen.ts   # Deno.open, Deno.FsFile
│   ├── 04_stdio.ts   # Deno.stdin, stdout, stderr
│   ├── 05_net.ts     # Deno.connect, Deno.listen
│   ├── 06_process.ts # Deno.Command
│   ├── 07_http.ts    # Deno.HttpClient
│   ├── 08_serve.ts   # Deno.serve
│   ├── 09_cron.ts    # Deno.cron scheduling
│   ├── kv/           # Deno.Kv (SQLite-backed, unstable)
│   │   ├── index.ts  # Deno.openKv, KvError classes
│   │   ├── types.ts  # KV type definitions
│   │   ├── core.ts   # Kv core implementation
│   │   ├── db.ts     # SQLite-backed storage
│   │   ├── atomic.ts # AtomicOperation
│   │   └── iterator.ts # KvListIterator
│   └── ffi/          # Deno.dlopen (unstable)
│       ├── index.ts  # dlopen, UnsafePointer, UnsafeCallback
│       ├── types.ts  # FFI type definitions
│       ├── pointer.ts # UnsafePointer/UnsafePointerView
│       ├── callback.ts # UnsafeCallback
│       └── library.ts # dlopen / DynamicLibraryImpl
├── node/             # Node.js compatibility
│   ├── fs/           # fs module
│   │   ├── mod.ts    # exports constants, sync, callbacks, promises
│   │   ├── constants.ts
│   │   ├── sync.ts   # fs.readFileSync, etc.
│   │   ├── callbacks.ts # fs.readFile, etc. (cb style)
│   │   ├── async.ts
│   │   ├── _promises.ts
│   │   ├── promises.ts # fs.promises.readFile, etc.
│   │   └── utils.ts  # FileHandle, Stats conversion
│   ├── path/         # path module
│   ├── os/           # os module
│   ├── util/         # util module
│   ├── events/       # events module
│   ├── stream/       # stream module
│   │   ├── mod.ts    # Readable, Writable, Duplex, Transform
│   │   └── promises.ts
│   ├── http/         # http, https modules
│   │   ├── mod.ts    # http.createServer
│   │   ├── server.ts # Server implementation
│   │   ├── client.ts # request, get
│   │   ├── constants.ts # STATUS_CODES, METHODS
│   │   └── types.ts
│   ├── https/        # https module
│   ├── http2/        # http2 module
│   ├── crypto/       # crypto module
│   │   ├── mod.ts    # createHash, createHmac, cipheriv, etc.
│   │   ├── helpers.ts
│   │   ├── random.ts
│   │   └── types.ts
│   ├── zlib/         # zlib module
│   ├── dns/          # dns module
│   │   ├── mod.ts
│   │   └── promises.ts
│   ├── net/          # net module
│   ├── dgram/        # dgram module
│   ├── child_process/ # child_process module
│   ├── worker_threads/ # worker_threads module
│   ├── url/          # url module
│   ├── querystring/  # querystring module
│   ├── assert/       # assert module
│   ├── console/      # console module
│   ├── process/      # process global
│   ├── timers/       # setTimeout, etc.
│   ├── v8/           # v8 module (stub)
│   ├── vm/           # vm module
│   ├── wasi/         # wasi module
│   ├── tls/          # tls module
│   ├── async_hooks/  # async_hooks module
│   ├── perf_hooks/   # perf_hooks module
│   ├── inspector/    # inspector module
│   ├── diagnostics_channel/ # diagnostics_channel module
│   ├── string_decoder/ # string_decoder module
│   ├── readline/     # readline module
│   │   ├── mod.ts
│   │   └── promises.ts
│   ├── repl/         # repl module
│   ├── module/       # module module
│   ├── buffer/       # buffer module (re-exports npm:buffer)
│   ├── tty/          # tty module
│   ├── ipc_channel/  # ipc_channel module
│   └── _internal/    # Internal helpers
│       ├── errno.ts  # ErrnoException conversion
│       ├── inject.ts # Node global injection
│       ├── memory.ts # Node.js memory tier detection
│       └── network-debug.ts # CDP Network helpers for Node http
├── cno/              # CNO-specific API
    ├── index.ts      # CNO global object
    ├── engine.ts     # CNO.engine (serialize, evalModule)
    ├── pty.ts        # CNO.openpty (pseudo-terminal)
    ├── compress.ts   # CNO.compress, decompress
    ├── ssl.ts        # CNO SSL helpers
    └── llhttp.ts     # CNO llhttp bindings
├── utils/            # Internal utilities
│   ├── args.ts       # CLI argument management, for deno and node polyfill
│   ├── assert.ts     # assert helper
│   ├── http.ts       # shared HTTP/1.1 TCP connection utilities
│   ├── malloc.ts     # buffer allocation helper
│   ├── memory-tier.ts # memory tier detection (low/normal/high)
│   ├── network-hooks.ts # CDP Network domain hooks (fetch/ws/serve)
│   ├── path.ts       # path utilities (join, dirname, normalize)
│   ├── platform.ts   # platform detection (isWindows, isMac, osShell)
│   └── wrap.ts       # error wrapping (errno → Deno error classes)
└── type/
    └── lib.cno.d.ts  # CNO namespace type declarations
```

### WebAPI Polyfill Details

**fetch/** — Maps WebAPI to @cnojs/http (split into request.ts, response.ts, perform.ts, xhr.ts):
```typescript
class Request implements globalThis.Request {
    url: string;
    method: string;
    headers: Headers;
    body: ReadableStream | null;
    // ...uses connectionManager from @cnojs/http
}

class Response implements globalThis.Response {
    status: number;
    headers: Headers;
    body: ReadableStream | null;
    arrayBuffer(): Promise<ArrayBuffer>;
    text(): Promise<string>;
    json(): Promise<any>;
}

async function fetch(input: RequestInfo, init?: RequestInit): Promise<Response>;
```

### Deno API Details

**deno/index.ts** — Deno global:
```typescript
globalThis.Deno = {
    errors: { NotFound, PermissionDenied, ConnectionRefused, ... },
    pid: number,
    ppid: number,
    args: string[],
    env: { get, set, has, delete, toObject },
    exit: (code?: number) => never,
    exitCode: number,
    build: { arch, os, target, vendor },
    version: { deno, v8, typescript },
    cwd: () => string,
    chdir: (dir: string) => void,
    mainModule: string,
    execPath: () => string,
    noColor: boolean,
    memoryUsage: () => { rss, heapTotal, heapUsed, external },
    systemMemoryInfo: () => { total, free, ... },
    hostname: () => string,
    loadavg: () => [number, number, number],
    osRelease: () => string,
    osUptime: () => number,
    permissions: { query, querySync, ... },
    cron: (name, schedule, handler) => void,
    test: DenoTest,
    bench: DenoBench,
    // ...fs, net, http APIs loaded via separate imports
};
```

### Node.js Compatibility Details

**node/fs/promises.ts** — fs.promises API:
```typescript
class FileHandleImpl implements FileHandle {
    fd: number;
    read(buffer, offset?, length?, position?): Promise<{bytesRead, buffer}>;
    write(buffer, offset?, length?, position?): Promise<{bytesWritten, buffer}>;
    close(): Promise<void>;
    stat(): Promise<Stats>;
    // ...
}

export const promises = {
    open(path, flags?, mode?): Promise<FileHandle>;
    readFile(path, options?): Promise<Buffer|string>;
    writeFile(path, data, options?): Promise<void>;
    readdir(path, options?): Promise<string[]|Dirent[]>;
    mkdir(path, options?): Promise<void|string>;
    rm(path, options?): Promise<void>;
    stat(path): Promise<Stats>;
    // ...
};
```

---

## Module 4: @cnojs/http — HTTP Protocol Library

**Location**: `http/`  
**Language**: TypeScript  
**Purpose**: Low-level HTTP protocol implementation, NO WebAPI dependencies

### Core Modules (`http/src/`)

| File | Purpose |
|------|---------|
| `h1.ts` | HTTP/1.x protocol (request builder, response parser, keep-alive, chunked) |
| `socket.ts` | TcpSocket — TCP/SSL raw I/O |
| `dns-cache.ts` | DnsCache — DNS resolution with TTL caching |
| `zlib.ts` | gzip/deflate compress/decompress |
| `protocol.ts` | Protocol interface abstraction |
| `server.ts` | Protocol-aware server (ALPN negotiation) |
| `debug.ts` | Debug logging and hex dump |
| `process.ts` | HTTP progress bar display |

**Type declarations** (`http/types/`): 30 `.d.ts` files for circu.js native modules:
`algorithm`, `asyncfs`, `console`, `crypto`, `curl`, `dns`, `engine`, `error`, `ffi`, `fs`, `fswatch`, `http`, `jsonc`, `os`, `process`, `signals`, `socket`, `sourcemap`, `sqlite3`, `ssl`, `streams`, `text`, `timers`, `udp`, `wasm`, `win32`, `worker`, `xml`, `zlib`.

**HTTP/2 extension** (`http/ext-h2/`): `http2.d.ts` — nghttp2 `Session` wrapper types.

**Utilities** (`http/utils/`): `assert.ts`.

### Design Principles
- **NO WebAPI types**: Does not use URL, Headers, Request, Response
- **Raw bytes + callbacks**: All I/O via `Uint8Array` and callbacks
- **CNO wrapping**: `cno/src/webapi/fetch/` maps WebAPI to this layer

Current note: standard fetch requests are curl-backed. The raw socket layer
is primarily for long-lived protocol transports such as SSE/WebSocket.

### TcpSocket Details

```typescript
class TcpSocket {
    socket: CModuleStreams.TCP;
    sslPipe: CModuleSSL.Pipe | null;
    
    constructor(socket?: CModuleStreams.TCP);
    
    // Callback-based readable
    onReadable(callback: (data: Uint8Array | null) => void, errHandler?: (err: Error) => void): void;
    stopReading(): void;
    
    // SSL-aware read/write
    async read(size?: number): Promise<Uint8Array | null>;
    async write(data: Uint8Array): Promise<void>;
    
    // SSL handshake
    async clientHandshake(hostname: string, sslContext?: CModuleSSL.Context): Promise<void>;
    async serverHandshake(sslContext: CModuleSSL.Context): Promise<void>;
}
```

### HTTP/1.x Implementation

```typescript
class HttpRequestBuilder {
    static DEFAULT_HEADERS: Array<[string, string]>;
    
    constructor(options?: H1RequestOptions);
    setHeader(name: string, value: string): void;
    setBody(data: Uint8Array): void;
    build(): Uint8Array;
}

class HttpResponseParser {
    onHeadersComplete: ((...) => void) | null;
    onData: ((chunk: Uint8Array) => void) | null;
    onComplete: (() => void) | null;
    feed(data: Uint8Array): void;
    getStatusCode(): number;
    getHeaders(): string[];
    getBodyChunks(): Uint8Array[];
    reset(): void;
    isCompleted: boolean;
}

const h1: { client: ProtocolClient; server: ProtocolServer; version: string };
```

### HTTP/2 (Native Extension)

HTTP/2 is provided by the `ext-h2` native extension (`http/ext-h2/http2.d.ts`):
```typescript
// CModuleExternalHTTP2 namespace
class Session { /* nghttp2 wrapper — HPACK, multiplexed streams */ }
const constants: { /* NGHTTP2_* frame types, error codes */ }
```
Statically linked via `CNO_EMBED_EXT_H2=ON` (requires nghttp2), or loaded from `ext/` at runtime.

### Protocol Interface

```typescript
interface ProtocolClient {
    connect(config: ProtocolClientConfig): Promise<ProtocolConnection>;
}

interface ProtocolServer {
    listen(config: ProtocolServerConfig): Promise<void>;
    close(): Promise<void>;
}

interface ProtocolConnection {
    receive(): void;
    wantWrite(): void;
    flush(): void;
    createStream(): ProtocolStream;
    on(event: string, handler: (...args: any[]) => void): void;
    goaway(): void;
    close(): void;
    destroy(): void;
}

interface ProtocolStream {
    writeHead(data: RawRequest | RawResponse): Promise<void>;
    writeData(data: Uint8Array): Promise<void>;
    end(): void;
    readMessage(): Promise<RawRequest | RawResponse | null>;
    abort(): void;
    close(): void;
}
```

---

## Module 5: ext-quic (@cnojs/quic) — QUIC Extension

**Location**: `ext-quic/` (git submodule)
**Language**: C (quicly + picotls) + TypeScript type declarations
**Purpose**: QUIC protocol native extension for WebTransport
**Type declarations**: `index.d.ts`, `native.d.ts` (Socket, Connection, constants)

### Dependencies
- **quicly**: QUIC protocol implementation
- **picotls**: TLS 1.3 implementation
- **OpenSSL**: Crypto library

### Build Options
- `CNO_EMBED_EXT_QUIC=ON` — Statically link into cno binary
- Or pre-build `.so`/`.dll` and place in `ext/` directory

### Usage
- `cno/src/webapi/webtransport.ts` — WebTransport API

---

## Module 6: ext-oxc — OXC Native Transpiler Extension

**Location**: `ext-oxc/`
**Language**: Rust (Cargo) + C (CMake glue)
**Purpose**: Native OXC-based TS/JSX transpiler, loaded as `import.meta.register('oxc', extPath)`

### Build
- Built alongside main project by `build.sh` / `build.ps1`
- Produces `swc.so` (Unix) or `swc.dll` (Windows)
- `cts/src/oxc.ts` provides the TypeScript interface (`OxcTranspiler`)

---

## Build System

### CMake Build Flow

```bash
cmake -B build -DCMAKE_BUILD_TYPE=Release
cmake --build build
```

### Build Steps
1. **circu.js runtime** → `cjs` binary
2. **cjsc compiler** → `cjsc` binary
3. **cno-cli bundle** → `dist/cno-cli.js` (via `pnpm run bundle`)
4. **Final cno binary** = `cjs` + self-attached bytecode

### CMake Options

| Option | Default | Description |
|--------|---------|-------------|
| `CNO_RELEASE` | OFF | Release build (enable CJS_USE_SYMBOL_INTERNAL, strip) |
| `CNO_BUNDLE_MINIFY` | OFF | Minify JS bundle |
| `CNO_SKIP_PNPM` | OFF | Skip pnpm install |
| `CNO_EMBED_EXT_H2` | OFF | Statically link HTTP/2 extension (requires nghttp2) |
| `CNO_EMBED_EXT_QUIC` | OFF | Statically link QUIC extension |
| `CJSC_PATH` | "" | Pre-built host cjsc executable |
| `CNO_EXT_DIR` | "" | Pre-built extensions directory |

### Static Extension Embedding

```cmake
# CJS_EXTRA_* hooks in circu.js CMakeLists
CJS_EXTRA_SOURCES
CJS_EXTRA_INCLUDE_DIRS
CJS_EXTRA_LIBS
CJS_EXTRA_MODULE_NAMES
CJS_EXTRA_MODULE_INITS
```

### Output Layout

```
build/stage/
├── cno[.exe]           # Final binary
├── ext/*.so|*.dll      # Native extensions (if CNO_EXT_DIR)
└── lib/                # Runtime libs
```

### pnpm Workspace

No `pnpm-workspace.yaml` — workspace packages are resolved via `workspace:` protocol in `package.json` dependency fields:
- `cno-cli` → `cts` (workspace:./cts), `@cnojs/http` (workspace:./http)
- `cts` → `@cnojs/http` (workspace:../http), `@cnojs/quic` (workspace:../ext-quic)

### Package Dependencies

```
cno-cli (root)
  ├── @cnojs/http (workspace:./http)
  ├── cts (workspace:./cts)
  └── node-buffer, ts-interface-checker

cts
  ├── @cnojs/http (workspace:../http)
  ├── @cnojs/quic (workspace:../ext-quic)
  └── sucrase, temporal-polyfill, urlpattern-polyfill, whatwg-url, ...

cno
  ├── @cnojs/http (workspace:../http)
  └── @cnojs/quic (workspace:../ext-quic)
```

---

## CLI Commands

### cno Commands

```bash
cno run <file> [args...]    # Run TS/JS file
cno <file> [args...]        # Implicit run
cno eval "<code>"           # Evaluate code
cno repl                    # Interactive REPL
cno test [paths...]         # Run tests
cno task [name]             # Run deno.json task
cno cache <file>            # Pre-cache dependencies
cno setup                   # Install Node.js polyfill files to cache
cno --version               # Version
cno --help                  # Help
```

### CLI Flags

```bash
--cache-dir <path>      # Cache directory (default: ~/.cts)
--lock-dir <path>       # Lock file directory
--no-lock               # Disable lock file
--frozen                # Fail if import not in lock
--reload, -r            # Bypass module cache
--precache              # Pre-cache dependencies
--no-http               # Disable http/https imports
--no-jsr                # Disable jsr: imports
--no-node               # Disable Node.js compat
--silent, -q            # Silent mode
--disable-cache         # Disable all caching
--memory-limit <size>   # e.g. 256MB, 1GB
--max-stack-size <size> # e.g. 4MB
--polyfill <path>       # Custom polyfill bundle
```

### Deno-compat No-op Flags

```bash
--allow-net, --allow-read, --allow-write, ...  # Permissions (always granted)
--unstable, --unstable-*, ...                   # Unstable features (ignored)
--check, --no-check                             # Type checking (ignored)
--import-map, --config                          # Config (cts uses own)
```

### Inspector Flags

```bash
--inspect[=host:]port   # Enable CDP inspector
--inspect-brk[=port]    # Enable inspector, break on first line
--inspect-wait[=port]   # Enable inspector, wait for client before running
```

---

## Environment Variables

| Variable | Description |
|----------|-------------|
| `CNO_POLYFILL` | Custom polyfill bundle path |
| `CNO_EXT_PATH` | Native extensions directory |
| `CTS_CACHE_DIR` | Cache directory override |
| `CTS_LOCK_DIR` | Lock file directory |
| `CTS_SILENT` | Silent output (true/false) |
| `DEBUG` | Debug categories: resolver, npm, jsr, lock, cjs, loader, config, stack, * |
| `CTS_DISABLE_CACHE` | Disable cache (true/false) |
| `CTS_ENABLE_HTTP` | Enable http imports (true/false) |
| `CTS_ENABLE_JSR` | Enable jsr imports (true/false) |
| `CTS_ENABLE_NODE` | Enable node compat (true/false) |
| `CTS_MEMORY_LIMIT` | Memory limit (e.g. 1GB) |
| `CTS_MAX_STACK_SIZE` | Max stack size |
| `CTS_WORKERS` | Precompile worker count (1-16) |
| `NPM_CONFIG_REGISTRY` | NPM registry URL |
| `NPM_TOKEN` | NPM auth token |

---

## Key Files Reference

### Entry Points

| File | Purpose |
|------|---------|
| `src/main.ts` | CLI entry point |
| `src/cli.ts` | Argument parsing (`parseArgv`) |
| `src/help.ts` | Help/version display |
| `src/bootstrap.ts` | Extension registration (`registerExtensions`) |
| `src/network.ts` | Proxy configuration and TLS cert verification |
| `src/version.ts` | Version string |

### Commands

| File | Purpose |
|------|---------|
| `src/commands/run.ts` | `runFile` — run TS/JS file |
| `src/commands/eval.ts` | `runEval` — evaluate code |
| `src/commands/repl/index.ts` | `runRepl` — interactive REPL |
| `src/commands/repl/runner.ts` | REPL evaluation logic |
| `src/commands/test.ts` | `runTest` — test runner |
| `src/commands/task.ts` | `runTask` — deno.json tasks |
| `src/commands/cache.ts` | `runCache` — cache management |
| `src/commands/setup.ts` | `runSetup` — install Node.js polyfill files |
| `src/commands/inspect.ts` | `parseInspectFlags` — --inspect flag parser |
| `src/commands/bin.ts` | `spawnBinary` — resolve and spawn node_modules binaries |

### Bundle Script

`scripts/bundle.mjs` — esbuild driver:
```javascript
// Modes:
//   release → dist/cno-cli.js (symbol mode, no import.meta.*)
//   dev     → dist/cno-cli.js (keeps import.meta.*)
//   min     → dist/cno-cli.min.js (release + minify)

// Symbol mode transform:
const SYMBOL_DEFINES = {
    'import.meta.use': '__cno_use__',
    'import.meta.register': '__cno_register__',
    'import.meta.dirname': 'undefined',
};

const SYMBOL_BANNER = {
    js: 'const __cno_use__=globalThis[Symbol.for("cjs.internal.use")],__cno_register__=globalThis[Symbol.for("cjs.internal.register")];',
};
```

### Inspector Subsystem (`src/inspector/`)

Full Chrome DevTools Protocol (CDP) implementation enabling `--inspect` debugging.

**Main thread** (`main/`): `Inspector` (composition root), `Evaluator` (expression eval),
`Serializer` (RemoteObject), `ObjectStore` (obj:N refs), `PauseController` (onBreak handler),
`Hooks` (script/lifecycle/console/network/binding bridges), `registerRpcHandlers`.

**Worker thread** (`worker/`): `bootstrapDebugWorker` (composition root), `CDPDispatcher` (routes CDP commands),
`CdpChannel` (WebSocket bridge), `createEventRouter` (WorkerEvent → domain dispatch), `startServer` (WS + `/json` discovery).

**Transport** (`transport/`): `MainEndpoint` + `WorkerEndpoint` (RPC facades),
`PipeClient`/`PipeServer` (async uv MessagePipe), `ChannelClient`/`ChannelServer` (sync native DebugChannel).

**CDP Domains** (`domains/`): `DebuggerDomain` (breakpoints, pause/resume state machine),
`RuntimeDomain` (evaluate, execution context, bindings), `ConsoleDomain` (buffered console messages),
`NetworkDomain` (fetch/serve/WebSocket → CDP Network.*), `FetchDomain` (request interception),
`PageDomain` (frame lifecycle), `TargetDomain` (target listing), `side-effect.ts` (safe eval analysis).

**Shared** (`shared/`): `cdp.ts` (CDP type definitions), `wire.ts` (WorkerEvent/PipeMsg enums),
`rpc-contract.ts` (RpcParams source of truth, transport routing), `native.ts` (debug module bindings),
`user-files.ts` (isUserFile), `console-utils.ts` (consoleAPICalled helpers).

---

## Code Style

### Naming Conventions
- **camelCase**: Functions, methods, variables (`fetchBytes`, `onprogress`, `cachePath`)
- **PascalCase**: Classes, interfaces, types (`ModuleCompiler`, `TcpSocket`)
- **UPPER_SNAKE_CASE**: Constants (`BUILTINS`, `ErrorKind`, `DEFAULT_HEADERS`)

### TypeScript Config
- `strict: true` — Strict mode
- `target: esnext` — Latest ES features
- `module: esnext` — ESM modules
- `moduleResolution: bundler` — Bundler mode
- `verbatimModuleSyntax: true` (cts) / `false` (cno)

### import.meta.use() Pattern

```typescript
// In cno/cts code
const fs = import.meta.use('fs');
const os = import.meta.use('os');
const engine = import.meta.use('engine');
```
To reduce the binary size, we will convert them to symbols by esbuild any time.
You should notice that build will NEVER check types, you should always use `pnpm run type-check` instead.

---

## Testing

### Test Framework
Deno-style testing:
```typescript
Deno.test("test name", async (t) => {
    await t.step("subtest", () => {
        // assertions
    });
});

Deno.test({ name: "ignored", ignore: true }, () => {});
Deno.test({ name: "only", only: true }, () => {});
```
Then, `cno test xxx.ts` will run all the tests.

### Test Runner
`src/commands/test.ts`:
- File pattern: `[._]test.[jt]sx?`
- Parallel execution with configurable concurrency
- Skip dirs: `node_modules`, `.git`, `dist`, `build`

### Run Tests
```bash
cno test                    # All test files
cno test src/module/        # Specific directory
cno test --concurrency=8    # Custom concurrency
```

---

## Debugging

### Enable Debug Logs

```bash
DEBUG=* cno run script.ts
DEBUG=resolver,npm,jsr cno run script.ts
DEBUG=loader,transformer cno run script.ts
```

### Debug Categories
- `resolver` — Module resolution
- `npm` — NPM package handling
- `jsr` — JSR package handling
- `lock` — Lock file operations
- `cjs` — CommonJS interop
- `loader` — Module loading
- `config` — Config loading
- `transformer` — TS transform
- `stack` — Stack trace handling

### Dev Mode Run

```bash
# Without building, use cts directly
cts src/main.ts run script.ts
```

### Bytecode Cache

- Location: `~/.cts/jsc/`
- Clear: `rm -rf ~/.cts/jsc/`
- Version mismatch auto-clears

### Syntax Error Debug

On SyntaxError, writes to:
```
~/.cts/fail-<md5>.log
```

---

## Extension Development

### Adding Built-in Module (circu.js)

1. Create `circu.js/src/mod_xxx.c`
2. Implement `tjs__mod_xxx_init(JSContext*)`
3. Register in `circu.js/src/modules.c`
4. Add type definitions to `circu.js/types/`

### Adding WebAPI Polyfill (cno)

1. Create `cno/src/webapi/xxx.ts`
2. Import in `cno/src/webapi/index.ts`

### Adding Node.js Module (cno)

1. Create `cno/src/node/xxx/mod.ts` (exports)
2. Create `cno/src/node/xxx/index.ts` (polyfill)
3. Add to `BUILTINS` in `cts/src/resolve/builtins.ts`
**WARNING** NODE MODULES SHOULD NEVER IMPORT MODULES OUTSIDE OF `cno/src/node`
IF YOU WANT TO USE, PLEASE USE `import.meta.use()` AS SHARED NAMESPACE TO DELIVER FN/VAR.

### Adding Protocol Handler (cts)

1. Create `cts/src/resolve/protocols/xxx.ts`
2. Implement `ProtocolHandler` interface
3. Register in `cts/src/resolve/index.ts`

### Adding Native Extension (unstable)

1. Create `ext-xxx/native.c`
2. Export `tjs_module_info`
3. Add CMakeLists.txt
4. Add to `EXTENSIONS` in `src/bootstrap.ts`

---

## Performance Notes

### Caches
- `pkgCache` — LRU 512 entries, 5min TTL
- `formatCache` — LRU 2048 entries
- `formatDirCache` — LRU 512 entries
- `exportsCache` — LRU 1024 entries
- `dnsCache` — TTL from DNS response

### Precompile
- Worker-parallel OXC (native) / Sucrase (fallback) transform
- Main-thread QJS compile (C layer, fast)
- Default workers: CPU cores (max 16, for big memory machines) and less

### Networking
- HTTP/2 multiplexing via native extension
- DNS caching with TTL
- SSL session reuse

---

## Author

iz (imzlh)

## License

MIT
