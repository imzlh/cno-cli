# AGENT.md - cno-cli Project Guide for AI Agents

## Project Architecture Overview

cno-cli is a Deno-compatible TypeScript CLI runtime built on circu.js. The project consists of **5 core submodules** forming a complete TypeScript runtime ecosystem:

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
```

---

## Module 1: circu.js — Core Runtime

**Location**: `circu.js/`  
**Language**: C (QuickJS + libuv)  
**Purpose**: Lightweight JavaScript runtime with ES2024+ engine and event loop

### Key Features
- **QuickJS**: ES2024+ JS engine (modules, Promise, Proxy, BigInt, async generators)
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
| `engine` | Runtime API | `eval`, `serialize`, `deserialize`, `gc`, `Module`, `onModule` |
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

### Type Definitions
- `circu.js/types/*.d.ts` — TypeScript definitions for all modules

### Build Targets
- `cjs` — Runtime binary (CLI)
- `cjsc` — Bytecode compiler (for self-attaching)
- `libcjs` — Static library (for embedding)

### Engine Module Details (`import.meta.use('engine')`)

```typescript
interface CModuleEngine {
    versions: {
        quickjs: string;
        tjs: string;
        uv: string;
        openssl: string;
        zlib: string;
        sqlite3: string;
        llhttp: string;
    };
    
    gc: {
        run(): void;
        setThreshold(bytes: number): void;
    };
    
    Module: {
        new(code: string, filename: string): Module;
        from(specPath: string, exports: object): Module;
        create(specPath: string): Module;
    };
    
    serialize(obj: any): Uint8Array;
    deserialize(buf: Uint8Array): any;
    
    eval(code: string, filename?: string): Module;
    waitPromise<T>(p: Promise<T>): T;
    
    setMemoryLimit(bytes: number): void;
    setMaxStackSize(bytes: number): void;
    
    onModule(hooks: {
        resolve?(spec: string, parent: string, attrs?: Record<string, any>): string;
        load?(specPath: string): Module;
        init?(specPath: string, meta: Record<string, any>): void;
        attrchk?(attrs: Record<string, any>): void;
    }): void;
    
    onEvent(handler: (type: EventType, data: any) => boolean): void;
    
    EventType: {
        PROMISE, UNHANDLED_REJECTION, JOB_EXCEPTION, EXIT, LOAD
    };
}
```

---

## Module 2: cts — TypeScript Loader

**Location**: `cts/`  
**Language**: TypeScript  
**Purpose**: Module resolution, TS transformation, multi-protocol support

### Core Components

| File | Purpose | Key Classes/Functions |
|------|---------|----------------------|
| `resolver.ts` | 3-level cache module resolver | `ModuleResolver` |
| `loader.ts` | ESM/CJS module loader | `ModuleLoader` |
| `transformer.ts` | TS/JSX → JS transform | `Transformer` (Sucrase) |
| `cjs.ts` | CommonJS interop | `CjsLoader`, `mkRequire` |
| `lock.ts` | Lock file management | `LockStore` |
| `jsc.ts` | Bytecode cache | `JscCache` |
| `runtime.ts` | Main runtime | `TypeScriptRuntime`, `createRuntime` |
| `config.ts` | Config loading | `createConfig`, `loadConfigFile` |
| `deps.ts` | Dependency scanner | `DepScanner`, `extractImports` |
| `precompile.ts` | Worker-parallel compile | `PrecompileDriver` |
| `pkg.ts` | package.json utils | `detectFormat`, `readPkg`, `resolveSubpath` |

### Protocol Handlers (`cts/src/protocol/`)

| Protocol | File | Description |
|----------|------|-------------|
| `file://` | `file.ts` | Local filesystem |
| `http://`/`https://` | `http.ts` | Remote modules with caching |
| `npm:` | `npm.ts` | NPM package resolution |
| `jsr:` | `jsr.ts` | JSR (Deno registry) packages |
| `node:` | `node.ts` | Node.js built-in modules |
| `data:` | `data.ts` | Data URL (RFC 2397) |

### Module Resolution Flow

```
1. L1 Cache: lock.sources["spec\0parent"] → specPath
2. L2 Cache: lock.modules[specPath] → ModuleInfo
3. L3 Dispatch: protocol handler → download if needed
```

### ModuleLoader Details

```typescript
class ModuleLoader {
    constructor(resolver: ModuleResolver, cfg: RuntimeConfig);
    
    load(info: ModuleInfo, meta?: Record<string, any>): Module;
    loadSource(code: string, info: ModuleInfo, meta?: Record<string, any>): Module;
    preRegister(localPath: string, parentPath: string): void;
    
    // Internal
    private transformer: Transformer;
    private cjs: CjsLoader;
    private esmCache: Map<string, Module>;
    private jsc: JscCache;
}
```

### ESM/CJS Interop Rules

```
ESM imports CJS → module.exports becomes `default`; named keys also exported
ESM imports CJS with __esModule=true → treat as transpiled ESM
CJS requires ESM → synchronously extract via engine.waitPromise
CJS requires CJS → normal require() chain
Circular CJS → return partial exports (Node.js behavior)
```

### TypeScriptRuntime Details

```typescript
class TypeScriptRuntime {
    resolver: ModuleResolver;
    loader: ModuleLoader;
    config: RuntimeConfig;
    
    constructor(cfg: RuntimeConfig, entryDir?: string);
    
    async precache(entrySpecPath: string, entryLocalPath: string): Promise<ScanResult>;
    async loadPolyfill(path: string): Promise<void>;
    async loadEntry(path: string, extra?: Record<string, any>): Promise<Module>;
    
    registerNodeResolver(r: NodeBuiltinResolver): void;
    flushLock(): void;
    
    private hookEngine(): void;  // Register engine.onModule hooks
    private fillMeta(meta: Record<string, any>, info: ModuleInfo): void;
}
```

### Lock File Format (NDJSON v2)

```
// cts.lock v2
{"s":"specPath","l":"localPath","f":"esm","k":"source"}
{"q":"spec\0parent","v":"specPath"}
```

### Config Loading Priority

```
1. CLI flags (highest)
2. Environment variables (CTS_*)
3. deno.json / deno.jsonc
4. tsconfig.json
5. package.json (imports field)
6. Defaults (lowest)
```

### Dependency Scanner

```typescript
class DepScanner {
    constructor(resolver: ModuleResolver, cfg: RuntimeConfig, progress?: PrecacheProgress);
    
    async scan(entrySpecPath: string, entryLocalPath: string): Promise<ScanResult>;
}

// Uses Sucrase tokenizer for import extraction (no regex)
function extractImports(source: string, isTs?: boolean): string[];
```

### Precompile (Worker-parallel)

```typescript
class PrecompileDriver {
    constructor();
    async precompile(modules: Array<{localPath: string}>, onProgress?: (done: number, total: number) => void): Promise<Map<string, Uint8Array>>;
    async terminate(): Promise<void>;
}

// Phase 1: Worker-parallel Sucrase transform (string→string)
// Phase 2: Main-thread QJS compile (Module + dump → bytecode)
```

### Transform Diagnostics Convention

- `cts/src/transformer.ts` is the boundary that converts Sucrase parse failures into structured diagnostics.
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
│   ├── fetch.ts      # fetch, Request, Response (maps to @cnojs/http)
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
│   ├── navigator/    # navigator.userAgent, etc.
│   └── console/      # console with formatting
├── deno/             # Deno API
│   ├── index.ts      # Deno global object
│   ├── 01_errors.ts  # Deno.errors
│   ├── 02_fs.ts      # Deno.readFile, writeFile, mkdir, etc.
│   ├── 03_fopen.ts   # Deno.open, Deno.FsFile
│   ├── 04_stdio.ts   # Deno.stdin, stdout, stderr
│   ├── 05_net.ts     # Deno.connect, Deno.listen
│   ├── 06_process.ts # Deno.Command
│   ├── 07_http.ts    # Deno.HttpClient
│   ├── 08_serve.ts   # Deno.serve
│   ├── kv/           # Deno.Kv (unstable)
│   └── ffi/          # Deno.dlopen (unstable)
├── node/             # Node.js compatibility
│   ├── fs/           # fs module
│   │   ├── mod.ts    # exports constants, sync, callbacks, promises
│   │   ├── sync.ts   # fs.readFileSync, etc.
│   │   ├── async.ts  # fs.readFile, etc. (cb style)
│   │   ├── promises.ts # fs.promises.readFile, etc.
│   │   └── utils.ts  # FileHandle, Stats conversion
│   ├── path/         # path module
│   ├── os/           # os module
│   ├── util/         # util module
│   ├── events/       # events module
│   ├── stream/       # stream module
│   ├── http/         # http, https modules
│   │   ├── mod.ts    # http.createServer
│   │   ├── server.ts # Server implementation
│   │   └── client.ts # request, get
│   ├── https/        # https module
│   ├── http2/        # http2 module
│   ├── crypto/       # crypto module
│   ├── zlib/         # zlib module
│   ├── dns/          # dns module
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
│   ├── repl/         # repl module
│   ├── module/       # module module
│   └── _internal/    # Internal helpers
│       ├── errno.ts  # ErrnoException conversion
│       └── inject.ts # Node global injection
└── cno/              # CNO-specific API
    ├── index.ts      # CNO global object
    ├── engine.ts     # CNO.engine (serialize, evalModule)
    ├── pty.ts        # CNO.openpty (pseudo-terminal)
    ├── compress.ts   # CNO.compress, decompress
    ├── ssl.ts        # CNO SSL helpers
    └── llhttp.ts     # CNO llhttp bindings
```

### WebAPI Polyfill Details

**fetch.ts** — Maps WebAPI to @cnojs/http:
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
    permissions: { query, querySync, ... },
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

### Core Modules

| File | Purpose |
|------|---------|
| `h1.ts` | HTTP/1.x protocol (request builder, response parser, keep-alive, chunked) |
| `h2.ts` | HTTP/2 protocol (nghttp2 wrapper, multiplexed streams, HPACK) |
| `socket.ts` | TcpSocket — TCP/SSL raw I/O |
| `connection.ts` | Connection, ConnectionManager — connection pooling |
| `dns-cache.ts` | DnsCache — DNS resolution with TTL caching |
| `zlib.ts` | gzip/deflate compress/decompress |
| `protocol.ts` | Protocol interface abstraction |
| `server.ts` | Protocol-aware server (ALPN negotiation) |
| `fetch.ts` | fetchBytes, fetchSync, fetchAsync |

### Design Principles
- **NO WebAPI types**: Does not use URL, Headers, Request, Response
- **Raw bytes + callbacks**: All I/O via `Uint8Array` and callbacks
- **CNO wrapping**: `cno/src/webapi/fetch.ts` maps WebAPI to this layer

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
    async connectTLS(hostname: string, sslContext?: CModuleSSL.Context): Promise<void>;
    async acceptTLS(sslContext: CModuleSSL.Context): Promise<void>;
}
```

### Connection Pooling

```typescript
interface ConnectionConfig {
    hostname: string;
    port: number;
    protocol: "http:" | "https:";
    timeout?: number;
    keepAlive?: boolean;
    keepAliveTimeout?: number;
    maxSockets?: number;
}

class Connection implements ConnectionLike {
    socket: CModuleStreams.TCP;
    sslPipe: CModuleSSL.Pipe | null;
    state: ConnectionState;
    
    connect(): void;
    connectAsync(): Promise<void>;
    write(data: Uint8Array): void;
    writeAsync(data: Uint8Array): Promise<void>;
    read(size?: number): Uint8Array | null;
    readAsync(size?: number): Promise<Uint8Array | null>;
    close(): void;
}

class ConnectionManager {
    acquire(config: ConnectionConfig): Promise<Connection>;
    release(conn: Connection): void;
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
    reset(): void;
    execute(data: Uint8Array): { complete: boolean; response?: RawResponse };
}

const h1: ProtocolClient & ProtocolServer;
```

### HTTP/2 Implementation

```typescript
class H2Stream implements ProtocolStream {
    id: number;
    state: string;
    
    writeHead(data: RawRequest | RawResponse): Promise<void>;
    write(data: Uint8Array): Promise<void>;
    end(): void;
}

class H2Connection implements ProtocolConnection {
    session: NgHttp2Session;
    
    request(req: RawRequest): Promise<H2Stream>;
    close(): void;
}

const h2: ProtocolClient & ProtocolServer;
```

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
    request(req: RawRequest): Promise<ProtocolStream>;
    close(): void;
}

interface ProtocolStream {
    writeHead(data: RawRequest | RawResponse): Promise<void>;
    write(data: Uint8Array): Promise<void>;
    end(): void;
    onClose: Event<Error | null>;
}
```

---

## Module 5: ext-quic (@cnojs/quic) — QUIC Extension

**Location**: `ext-quic/`  
**Language**: C (quicly + picotls) + TypeScript  
**Purpose**: QUIC protocol native extension for WebTransport

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
| `CNO_EMBED_EXT_H2` | ON | Statically link HTTP/2 extension |
| `CNO_EMBED_EXT_QUIC` | OFF | Statically link QUIC extension |
| `CNO_EXT_DIR` | "" | Pre-built extensions directory |
| `CNO_HOST_CJSC` | "" | Pre-built host cjsc (for cross-compile) |

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

```yaml
packages:
  - '.'
  - './cts'
  - './cno'
  - './http'
  - './ext-quic'
```

### Package Dependencies

```
cno-cli (root)
  ├── @cnojs/http (workspace:./http)
  └── cts (workspace:./cts)

cts
  └── @cnojs/http (workspace:../http)

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
--inspect, --inspect-brk                        # Debug (ignored)
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

---

## Code Style

### Naming Conventions
- **camelCase**: Functions, methods, variables (`fetchBytes`, `onprogress`, `cachePath`)
- **PascalCase**: Classes, interfaces, types (`ModuleLoader`, `TcpSocket`)
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

### Symbol Mode (Release Build)

```typescript
// After bundling, import.meta.use is replaced
const use = globalThis[Symbol.for('cjs.internal.use')];
const fs = use('fs');
```

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

### Adding WebAPI Polyfill (cno)

1. Create `cno/src/webapi/xxx.ts`
2. Import in `cno/src/webapi/index.ts`

### Adding Node.js Module (cno)

1. Create `cno/src/node/xxx/mod.ts` (exports)
2. Create `cno/src/node/xxx/index.ts` (polyfill)
3. Add to `BUILTINS` in `cts/src/cjs.ts`

### Adding Protocol Handler (cts)

1. Create `cts/src/protocol/xxx.ts`
2. Implement `ProtocolHandler` interface
3. Register in `cts/src/resolver.ts`

### Adding Native Extension

1. Create `ext-xxx/native.c`
2. Export `tjs_module_info`
3. Add CMakeLists.txt
4. Add to `EXTENSIONS` in `src/bootstrap.ts`

---

## Common Issues

### Q: Module not found
A: Check protocol is enabled (`--no-http`, `--no-jsr`, `--no-node`)

### Q: Lock file error
A: Use `--no-lock` to disable, or `--frozen` for CI

### Q: Memory limit exceeded
A: Use `--memory-limit 512MB`

### Q: Circular dependency
A: CJS circular deps return partial exports (Node.js behavior)

### Q: ESM/CJS interop issue
A: Check `__esModule` flag on CJS module

### Q: Release vs Dev build
A: Release enables `CJS_USE_SYMBOL_INTERNAL`, converts `import.meta.use` to Symbol

---

## Performance Notes

### Caches
- `pkgCache` — LRU 512 entries, 5min TTL
- `formatCache` — LRU 2048 entries
- `formatDirCache` — LRU 512 entries
- `exportsCache` — LRU 1024 entries
- `dnsCache` — TTL from DNS response

### Precompile
- Worker-parallel Sucrase transform
- Main-thread QJS compile (C layer, fast)
- Default workers: CPU cores (max 16)

### Connection Pool
- Keep-alive with configurable timeout
- Max sockets per host
- HTTP/2 multiplexing

---

## Author

iz (imzlh)

## License

MIT
