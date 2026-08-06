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
 - Before you edit that, please think whether rewrite or just make some patch
   You can redesign 
 - cts: Do not optimize the module specially. For example, optimized to treat `vite.config.js` to esm.
 - cts: We assumed that cache in lock are correct, never try to add verify logic to cts source code.
 - cts: Never infer ESM/CJS from source contents; use extensions, package metadata/conditions, or an explicit caller format.
 - after modifing codes and files that mentioned here, you are supposed to change the content below.
 - testing: if you only modified source in `cno/src/node/`(exclude `_internal/inject.ts`), only `cno setup` is required to refresh cache (don't forget to set cwd to the project!), or you should use `cmake -B build` to rebuild binary (TS will automately attach into the binary)
 - runtime/native: keep Node-like host symbol exports for TJS/N-API addons, but isolate `Deno.dlopen` FFI libraries from host symbols on Linux with a separate loader namespace.
 - These warnings are edited by user, you should take into account more carefully.

## Code Style Guide
This is my code style. Follow this, better us.
```ts
/** top level comment, optional */
import type { a } from '';
import * as xx from '';

const fs = import.meta.use('fs');   // NO CASTING

// 1~2 line to place comments is enough.
// NEVER EXCEED 2 LINE WHEREEVER, WHENEVER
const { b } = var_c; // some pre-defined variables

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
| `zlib` | Compression | `deflate`, `inflate`, `gzip`, `gunzip` |
| `brotli` | Brotli compression | `compress`, `decompress`, `createCompress`, `createDecompress` (built with libbrotli; check `available`) |
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
| `bjson` | Stable binary JSON | Versioned value persistence codec |
| `text` | Text | iconv-based encoding conversion |
| `signals` | Signals | POSIX signal handling |
| `curl` | HTTP client | libcurl-based HTTP client (used by fetch) |
| `udp` | UDP | dgram/UDP socket support |
| `debug` | Debugging | Debugger support (used by CDP debugger) |
| `win32` | Windows | Windows-specific APIs |
| `nodeapi` | Native Layer | Node.js-compatible n-api bindings for node native modules(.node) |

### Type Definitions
- `circu.js/types/*.d.ts` — TypeScript definitions for all modules

### Build Targets
- `cjs` — Runtime binary (CLI)
- `cjsc` — Bytecode compiler (for self-attaching)
- `libcjs` — Static library (for embedding)

### Engine Module Details (`import.meta.use('engine')`)
**Location**: `circu.js/types/engine.d.ts`

Use the engine's no-trap brand predicates for built-in identity checks. This includes
Arguments, generator functions/objects, Map/Set iterators, and module namespaces;
do not replace them with `instanceof`, `@@toStringTag`, or constructor-name checks.

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
│   ├── linker.ts               # node_modules materialization (--npm-mode, see below)
│   └── protocols/              # Protocol handlers
│       ├── base.ts             # ProtocolHandler interface + guessFileKind
│       ├── file.ts             # file://
│       ├── npm.ts              # npm: registry resolution
│       ├── jsr.ts              # jsr: Deno registry
│       ├── http.ts             # http:/https: remote modules
│       ├── node.ts             # node: built-in polyfills
│       ├── data.ts             # data: URLs (RFC 2397)
│       └── pack.ts             # pack:/ctsview: manifest-only resolution
│
├── source/                     # Layer 2: read files + transform (CJS/ESM agnostic)
│   ├── index.ts                # readSource(), readSourceForCjs()
│   ├── transform.ts            # Transformer (OXC native primary, Sucrase fallback)
│   └── cache.ts                # JscCache L1(memory)+L2(disk) bytecode cache
│
├── compile/                    # Layer 3: compile + cache + bridge
│   ├── index.ts                # ModuleCompiler facade (orchestrates ESM/CJS/WASM)
│   ├── esm.ts                  # EsmCompiler: engine.Module compilation + esmCache + circular deps
│   ├── cjs.ts                  # CjsLoader: CJS exec, mkRequire factory, requireEsm, loadBuiltin
│   ├── wasm.ts                 # WasmCompiler + buildWasmModule: WASM loading + circular deps
│   ├── bridge.ts               # CJS↔ESM bridge: bridgeCjsToEsm, loadEsmSync (promiseResult), installGlobalRequire
│
├── api/                        # Layer 4: public API surface for external consumers (cno-cli)
│   └── index.ts                # Re-exports createRuntime, config, path utils, errors, types, etc.
│
├── runtime/                    # Composition root: lifecycle + engine hooks
│   ├── index.ts                # TypeScriptRuntime + createRuntime
│   ├── hooks.ts                # engine.onModule (resolve/load/init/attrchk) + loadedModules dedup
│   ├── meta.ts                 # import.meta population (url, filename, dirname, resolve)
│   ├── lifecycle.ts            # planLifecycleScript (npm lifecycle scripts)
│   ├── event-mux.ts            # engine event multiplexing
│   └── resources.ts            # ResourceManager class (instance-based, not singleton)
│
├── utils/                      # Shared utilities (barrel: utils/index.ts)
│   ├── index.ts                # Re-exports all utils modules
│   ├── platform.ts             # uname, isWindows (no deps, breaks circular)
│   ├── bin.ts                  # Binary resolution, `exec` pnpm-liked runner
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
├── precompile.ts               # Thin re-export of parse.ts (ParseDriver worker scan/transform)
├── import-scanner.ts           # OXC-first import extraction used by parse workers
├── scan.ts                     # Sucrase extractImports + cheap hasImportAttributes detector
├── pack/                       # .jspack format validation, writer, extraction/reader
├── shell.ts                    # Shell command parser
├── task.ts                     # deno.json/package.json task runner
├── task-shell.ts               # shell/bin-wrapper resolution for the task runner
├── wasm-imports.ts             # WASM import-module extraction (pack graph edges)
├── debug/                      # Debugger integration (bridge.js)
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
    moduleId?: string;          // QuickJS identity for alternate module views
    cacheBytecode?: boolean;    // false when bytecode cannot preserve semantics
}

interface ConfigOptions {
    cacheDir?: string;
    enableHttp?: boolean;
    enableJsr?: boolean;
    enableNode?: boolean;
    enableCache?: boolean;     // default: true (inverted from old disableCache)
    enableOxc?: boolean;
    silent?: boolean;
    disableLock?: boolean;     // renamed from noLock — in-memory only
    persistLock?: boolean;     // write cts.lock to disk (only `cno cache`)
    frozen?: boolean;
    lockDir?: string;          // override lock dir (default: project root, else cache dir)
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

### node_modules Materialization (`--npm-mode`, resolve/linker.ts)

cts resolves npm packages against a flat content-addressed store
(`<cacheDir>/npm/<name>@<version>/`). **Install** owns store-internal soft
links (`storePkg/node_modules/dep` → another store package). **Materialize
never writes under the store** — only under the project `node_modules`.

`--npm-mode=<normal|soft|hard>` (default `normal` = no project tree):
- `soft` — project-root symlinks/junctions into the flat store only. Nested
  resolution walks install-owned soft links under each store package.
- `hard` — pnpm-style project virtual store at `node_modules/.cts/`: each
  `name@version` body is hard-linked **once** (store `node_modules` skipped);
  dependency edges and project roots are soft links into that virtual store.
  Shared deps share one body. Incremental: unchanged bodies (store
  `package.json` size+mtime stamp) are skipped; store updates rebuild that
  body; packages no longer in the graph are pruned from `.cts`. Store stays
  read-only.

Project roots come from `DepScanner` scan edges. Required missing store
packages fail closed from `materializeNodeModules`.

The unversioned store alias (`<store>/<name>`, no `@version`) points at whatever
version was written last, so `resolveStorePackage` only accepts it when it
actually **satisfies the requested range**. Taking it unconditionally silently
hands back an unrelated major.

`publishResolved` records `specPath → ModuleInfo` in `resolvedModules` for
**every** resolve, including transient (`attr.cjs === true`, i.e. `require`)
ones — transient only fills when the key is absent, so a later ESM resolve wins.
A package under a project `node_modules` still gets an `npm:name@ver/sub`
identity whose `localPath` is *not* derivable from the store layout, so without
that entry `getInfo()` falls through to `NpmHandler.localPath()` and
`require()`-ing an ESM file in a local package fails with
"Package not in cache". Lock writes (`setModule` / `setSourceByKey`) stay gated
on `!transient`.

Local (relative/absolute) specifiers are resolved literally first, then
percent-decoded (`resolveLocalFile`): Node treats ESM specifiers as URLs, so
`./with%20space.mjs` must reach `with space.mjs`, while a file whose name really
contains `%` keeps working.

CJS package subpath resolution follows Node's `LOAD_AS_DIRECTORY` order —
exact file → `base+ext` → nested `package.json` `main` → directory index.
`resolvePackageSubpath` therefore takes the `ResolveCtx` on the `forceCjs` path;
`resolveLegacyPath` (main/module targets) deliberately does **not** pass it,
because Node does not recurse into a nested `package.json` for a `main` target.

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
ESM imports CJS with __esModule=true AND an own `default` key → treat as
  transpiled ESM (bundler-style unwrap: `default` = `exports.default`).
  With no own `default` key it falls back to true-CJS (`default` = whole
  exports), which is what Node does — never `undefined`.
  `__esModule` itself is re-exported as a named export (Node does too).
CJS requires ESM → loadEsmSync via engine.promiseResult:
  - throws → propagate (module error)
  - returns null → top-level await unresolved → throw "cannot require() async ESM"
    (carries `code = 'ERR_REQUIRE_ASYNC_MODULE'`, as Node does)
  - returns truthy → return mod.namespace (live reference, C++ native)
  IMPORTANT: the null check must NOT be weakened by checking namespace size —
  a module with sync exports AND top-level await returns null but has a
  non-empty namespace; returning it causes a silent dead-lock.
CJS requires CJS → normal require() chain
Circular CJS → return partial exports (Node.js behavior)
Circular CJS↔ESM crossed by require() → **throw ERR_REQUIRE_CYCLE_MODULE**, as
  Node does. Two message shapes, matching upstream:
    require(esm) where the ESM is mid-compile/mid-eval →
      "Cannot require() ES Module X in a cycle."   (bridge.ts loadEsmSync)
    import cjs where the CJS body is on the stack →
      "Cannot import CommonJS Module X in a cycle." (compile/index.ts CJS branch)
  The CJS body must still NOT re-run: throw *before* loadAndGet, never re-enter.
  Pure-CJS cycles (partial exports) and pure-ESM cycles (TDZ error) are NOT
  refused — measured against Node v24.18.0. A cycle escaped via dynamic
  `import()` from a mid-load CJS module is also allowed by both runtimes,
  because the import settles after the CJS body has returned.
```

Cycle detection uses two windows, and both are required:

- `CjsLoader.executing` — CJS bodies on the stack. `isExecuting()` is what
  `compile/index.ts` consults before bridging a CJS module into the ESM graph.
- `EsmCompiler.esmInFlightPaths` + `esmEvaluating` — ESM modules mid-compile and
  mid-evaluate. `esmLoading` alone is **not** enough: `esm.ts` clears it when
  compilation finishes, long before evaluation ends, so a CJS module reached
  during an ESM module's evaluation could require() that module back and call
  `.eval()` on a module in `JS_MODULE_STATUS_EVALUATING`. That status is absent
  from `js_link_module`'s assert allow-list (quickjs.c:32216-32218), so it
  **aborts the process** rather than throwing. Both sets are keyed by
  `localPath`, not `moduleRef`: require() arrives via `infoFromLocalPath`
  (`specPath === localPath`) while the ESM graph may key the same file under an
  `npm:`/`file:` spec or a `moduleId`, and keying on `moduleRef` silently misses
  those cycles.

`CjsLoader` tracks an `executing` set because a cache entry does not say whether
a body is on the stack: `preRegister()` stores never-executed stubs and those
also have `loaded === false`. `loadAndGet` short-circuiting on `loaded` alone
re-executed a module that was mid-execution whenever ESM imported a CJS module
that required it back (`compile/index.ts` → `loadAndGet` on the bridge path).
That ran every side effect twice and re-entered the `engine.Module` currently
being instantiated — a **segfault**, not an exception. Keep the
`loaded || executing` guard on all three execution entry points.

Every bridged CJS namespace also carries a `module.exports` named export, which
is what upstream Node does (`Object.keys(ns)` on a CJS module includes it). A
real export literally named `module.exports` still wins over the synthetic one.

Named exports are emitted with quoted binding names
(`export { local as "…" }`, ES2022 arbitrary module namespace names — verified
supported by the QuickJS build), so keys that are not valid identifiers
(`foo-bar`, reserved words, keys with spaces) survive the bridge instead of
being silently dropped.

`require.cache` keys are host paths on the boundary but POSIX internally: the
proxy normalises on every trap and maps back in `ownKeys`, so
`delete require.cache[module.filename]` works on Windows.

### import.meta / import attributes — known divergences

`import.meta.url`, `import.meta.filename` and `import.meta.dirname` all match Node
exactly (OBSERVED 2026-08-02, byte-identical to node v24.18.0 for the same file):
`file:///D:/tmp/x/meta.mjs`, `D:\tmp\x\meta.mjs`, `D:\tmp\x` — URL for `url`, native
separators for the other two.

**`import.meta.resolve()` is NOT a pure specifier→URL mapping here — it resolves for
real, and throws.** This is the sharp edge in this area and it was undocumented.
Node's `resolve()` performs no existence check (only a bare-package lookup can
fail); cno's hits the filesystem and, for `http(s):`, **the network**. OBSERVED
2026-08-02, same script both runtimes:

| specifier | cno | node v24.18 |
|---|---|---|
| `./exists.mjs` | `file:///…/exists.mjs` | same |
| `./missing.mjs` | **throws** `Cannot resolve: …/missing.mjs` | `file:///…/missing.mjs` |
| `./nested/missing.mjs` | **throws** | `file:///…/nested/missing.mjs` |
| `node:fs` | `node:fs` | same |
| `node:nonexistent-xyz` | **throws** `builtin … has no polyfill` | `node:nonexistent-xyz` |
| bare uninstalled package | throws `MODULE_NOT_FOUND` | throws `ERR_MODULE_NOT_FOUND` (agrees) |
| `https://example.com/y.js` | **throws `MODULE_NOT_FOUND: HTTP 404 fetching …`** | `https://example.com/y.js` |

Consequences worth internalising:
- **Do not use `import.meta.resolve()` to compute a path for a file you are about to
  create** — it throws on the not-yet-existing target. Build the URL with
  `new URL(spec, import.meta.url)` instead.
- The `https:` row means `resolve()` can perform a **network request**, so it can
  hang, 404, or contact a remote host as a side effect of what looks like string
  manipulation. Treat it as I/O, not as a pure function.
- Report as a code bug rather than working around it in callers: resolution and
  existence-checking should be separable.

`fillMeta` (`runtime/meta.ts`) returns `import.meta.resolve()` as a **URL string**
via the same `toImportMetaUrl()` mapping as `import.meta.url`, so the two agree
**on the cases that resolve at all**: `file:///D:/x/dep.mjs` for disk modules, scheme
preserved for `node:fs` / `http(s):` / `pack:`, and `npm:`/`jsr:` mapped to the
resolved `file://` path. It previously returned a bare host path (`D:/x/dep.mjs`) and
mapped `node:fs` to the polyfill's local path, which broke strict URL consumers;
that divergence from Node / `cno/lib.deno.d.ts` is fixed. The remaining
divergence is `npm:`/`jsr:` → `file://` rather than the `npm:` specifier Deno
returns — deliberate, and shared with `meta.url`.

Import attributes fail closed. `attrchk` (`runtime/hooks.ts`) rejects unknown
attribute names with `ERR_IMPORT_ATTRIBUTE_UNSUPPORTED`; the resolver rejects
unknown `type` values and checks `type: 'json'` against the original `fileKind`,
raising `ERR_IMPORT_ATTRIBUTE_TYPE_INCOMPATIBLE` before creating a module view.
The nonstandard `text` / `bytes` views remain supported. Leniency for a *missing*
attribute on real JSON is deliberate (Deno compat) — keep it.

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
    cleanup(): void;             // terminal teardown; also resources.release() (one-shot)
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

`release()` is **one-shot**: after it, `register()` runs the cleanup immediately
instead of queueing it, so a runtime is not reusable once released. `cleanup()`
now calls it, so `cleanup()` is terminal — do not call it between two phases of
work on the same runtime.

**`runPrecache` cleans up in a single `finally`.** The post-scan `flushLock()` and
the `hasFresh()` precompile gate previously sat outside every cleanup path, and
`await parseDriver.terminate()` was reached only on specific branches. A throw
from either left the compile workers alive holding the libuv loop open, so
`cno cache` **hung** instead of reporting the error — which looks exactly like the
89 s cold-compile problem and invites the wrong diagnosis. `prog.stop()`,
`parseDriver.terminate()` and `resources.release()` are each idempotent
(`stopped` flag / emptied worker array + guarded `finish()` / `done` flag), so the
five per-branch copies were pure duplication and were removed.

### C Layer Single-Callback Constraint

circu.js C layer registers most callbacks as **replacement** (not append):
- `engine.onModule()` — only one set of resolve/load/init/attrchk hooks active
- `engine.onEvent()` — only one event handler
- `engine.promiseHook()` — only one promise hook

Creating a second `TypeScriptRuntime` in the same process will **replace** the
prior runtime's engine hooks and `globalThis.require` getter. The code logs a
warning on re-install but does not prevent it. Workers have independent
JSContexts so this constraint applies per-process, not per-worker.

### C Layer Memory Allocator Rules

- **`tjs__malloc`/`tjs__free`** — global, not tracked by QuickJS
- **`js_malloc`/`js_free`** — per-runtime, tracked by `rt->malloc_state.malloc_size`

Structs embedding a `uv_handle_t` (freed from `uv_close` cb, possibly after rt teardown) use `tjs__`.
Pure JS-associated data (freed from finalizer / while ctx alive) uses `js_`.
Mixing them causes `malloc_size underflow` at teardown.

**`uv_queue_work` work callbacks must never touch `js_malloc`/`js_realloc`/`js_free`
(or anything backed by them, e.g. a `DynBuf` from `tjs_dbuf_init`).** The work
callback runs on a libuv threadpool thread, concurrently with the main thread —
`rt->malloc_state` has no lock, so this is a silent data race, not a crash at
the call site. It only surfaces later, non-deterministically, as `malloc_size
underflow` at an unrelated free (often at final `JS_FreeRuntime`/GC teardown),
because it corrupts the tracked byte counter rather than the heap itself.
Symptoms that point here: crash reproduces on a normal build but disappears or
never happens under gdb/ASan (both change scheduling/timing enough to dodge
the race window) — confirm with ThreadSanitizer (`-fsanitize=thread`), which
catches it on the first run. Fix: grow the buffer in the work callback with
`tjs__malloc`/`tjs__realloc` (see `dbuf_init2(&buf, NULL, <tjs__realloc wrapper>)`),
and give the resulting `ArrayBuffer`/`Uint8Array` a `tjs__free`-based finalizer
instead of the default tracked one. Only the *after_work* callback (runs back
on the main thread) may touch `js_*`/QuickJS APIs.

**A third allocator exists: plain libc `malloc`/`free`.** `tjs__*` is
`mi_*` under `CJS__HAS_MIMALLOC`, so freeing a `tjs__malloc`'d pointer with
libc `free` (or vice versa) corrupts the heap outright — not just the tracked
counter. Never mix the three families; match every free to its allocator.

### Every worker runtime leaks 56 bytes / 2 blocks (unfixed)

A worker that runs **no JS at all** leaks `56 bytes in 2 blocks`, reported by
QuickJS's `JS_DUMP_LEAKS` check (`deps/quickjs/quickjs.c:2865-2870`). That report
needs **two** gates, which is why most builds never print it: `JS_SetDumpFlags`
under `#ifdef DEBUG` at `circu.js/src/vm.c:435`, **and** `#ifdef ENABLE_DUMPS`
around the `printf` in `quickjs.c`. Measured on
raw `cjs.exe` with a 6-line script, so no cno/cts code is involved; the count
scales exactly with the number of workers (3 workers → 3 lines) and is constant
regardless of what the worker does. The **main** runtime reaches the same check
via `cli.c:82` and is clean, so this is worker-bootstrap-specific.

It is `js_malloc`-tracked memory with **no JSObject owner** — the object-leak dump
is empty, and `tjs__malloc` blocks (`TJSMessagePipe`, `TJSWorker`, `worker_data_t`)
are invisible to this counter by construction. Ruled out by measurement: udata
(leaks equally with `undefined`/number/object), message traffic (equal with and
without), and `tjs__mod_worker_init` (a worker that never loads the `worker`
module still leaks — branch on the `isWorker` **global** from `vm.c:482`). That
narrows it to `worker_entry`'s own bootstrap, `reg_msgpipe` +
`tjs_new_msgpipe(ctx, wd->channel_fd)` (`mod_worker.c:687-688`), but the exact
allocation is **not** pinned — naming it needs ASan/Valgrind or a counter probe
around those two calls, which requires a rebuild.

Why it matters beyond hygiene: the message goes to **stdout** via `printf`, so it
corrupts any command that must be silent. `cno pack -q` is asserted to emit
exactly nothing (`tests/cts/pack-command.test.ts:273`), and it spawns transform
workers, so the assertion fails on any Debug build. The failure is **gated on
worker count**, not on pack: `CTS_WORKERS=0 cno pack -q` is clean,
`CTS_WORKERS=2` is not. Since `resolveWorkerPolicy` derives the count from the
memory tier and core count (`cts/src/parse.ts`), whether this test passes depends
on the host's free memory at run time — do not read an intermittent pass as fixed.

**This no longer reproduces on the current binary — do not plan around it.** It
did on the 08-01/08-02 builds, where `CTS_WORKERS=2 cno pack … -q` put **77
bytes** (`Memory leak: 56 bytes lost in 2 blocks`, once per worker) on stdout at
exit 0, while `CTS_WORKERS=0` was clean. Re-measured OBSERVED 2026-08-04 against
the 22:51 `build/stage/cno.exe`:

| probe | result |
|---|---|
| `CTS_WORKERS=2 cno pack e.ts -q -o out.jspack --no-oxc` | stdout **0 bytes**, exit 0 |
| `grep -a -c 'Memory leak' build/stage/cno.exe` | **0** (control `ERR_REQUIRE_ASYNC_MODULE` = 1) |
| `grep -a -c 'bytes lost' build/stage/cno.exe` | **0** |

`build/CMakeCache.txt` still says `CMAKE_BUILD_TYPE=Debug`, so **"the build dir is
Debug" does not imply the leak dump is compiled in** — `ENABLE_DUMPS` is the gate
that is off, and the dump string is absent from the binary entirely. Note this
also means the leak is now *unmeasured*, not fixed: absence of the report is not
absence of the leak, and re-checking it needs a build with `ENABLE_DUMPS` on.

What survives as guidance: the exit code stays 0 either way, so a stdout-parsing
probe should still tolerate stray lines rather than assume cleanliness, and
`CTS_WORKERS=0` is still the cheapest way to rule workers out of a stdout
question.

### uv_close / Finalizer Rendezvous

A struct embedding a `uv_handle_t` has **two** owners: the JS wrapper
(finalizer) and libuv (`uv_close` cb). Neither may free unilaterally — the
close cb can fire while the JS wrapper is still reachable (e.g. after an
explicit `close()`), and the finalizer can run while a close is still in
flight. Use the two-flag pattern (`closed` + `finalized`, as in
`mod_fswatch.c` / `mod_worker.c` msgpipe): each side sets its own flag and
frees only if the other flag is already set. Testing `uv_is_closing()` in the
finalizer is **not** a substitute — it says a close is pending, not that the
cb has run.

For a struct shared with a *thread* (not just the loop), the "who frees"
decision must be a single atomic read-modify-write **under the lock**. Setting
a flag outside the lock and then re-reading the peer's state is a double-free
race (see `worker_gc_claim_free` / `worker_thread_claim_free`).

Handle-completion callbacks (`uv__write_cb` and friends) must bail out on
`s->finalized || !qrt || qrt->freeing` **before** calling into JS: teardown
cancels pending requests with `UV_ECANCELED`, so these callbacks do fire
against a dying runtime. Release the request with an `_rt` variant that frees
the promise and JSValues via `JS_FreeValueRT`/`TJS_FreePromiseRT`.

### `for await` does not run AsyncIteratorClose

`OP_iterator_close` (`deps/quickjs/quickjs.c:19992`) calls the **synchronous**
`JS_IteratorClose`, and `quickjs-opcode.h:214` defines only that one opcode — there
is no async variant. The compiler emits it for `for await` too
(`quickjs.c:29252`, on `top->has_iterator`), so breaking out of a `for await` loop
calls the iterator's `return()` but **never awaits the returned promise**, where
ECMA-262 AsyncIteratorClose requires it.

Measured with a plain hand-written async iterator (no streams involved): an
`async return()` that awaits before setting a flag leaves the flag unset when the
loop body `break`s — Node sets it. The observable effect is that any cleanup an
async iterator performs in `return()` lands a macrotask late; `ReadableStream`
works around it by releasing its reader lock before the await (see the
"iterator lock" row under WebAPI conformance). A real fix needs a distinct
awaiting close opcode, so callers should not assume `return()` has completed when
a `for await` loop exits early.

### C Function argc/argv Discipline

QuickJS pads `argv` only up to the **declared length** in the
`JS_CFUNC*_DEF(name, length, ...)` entry. Reading `argv[n]` where
`n >= length` is an out-of-bounds stack read, even for `JS_IsUndefined()`
checks. Either declare the real arity or guard with `argc >= n + 1`.

### Detached ArrayBuffer / Raw Buffer Pointer Discipline

`JS_GetUint8Array` / `JS_GetArrayBuffer` / `JS_GetTypedArrayBuffer` return a
pointer **directly into the ArrayBuffer backing store**. Once you hold one, **no
JS may run before you finish using it** — user JS can call
`ArrayBuffer.prototype.transfer()` (or a transferring `structuredClone`) to
detach the buffer and free that memory, and your pointer is then a
use-after-free. Rooting the JSValue does **not** help: detaching is explicit, not
GC-driven.

Anything that can re-enter JS counts: `JS_To*` numeric conversions (`valueOf`),
`JS_ToCString` on an object (`toString`), `JS_GetPropertyStr` /
`JS_SetPropertyStr` (getters, setters, Proxy traps), `JS_Call`, and iteration
protocols. Therefore **hoist every conversion above the buffer acquisition** —
`tjs_sock_setsockopt` (`mod_socket.c`) is the reference ordering. Two confirmed
UAFs were fixed this way: `tjs_sock_send` and `tjs_sock_sendmsg` converted
`flags` *after* capturing the payload pointer.

`JS_GetAnyBuffer` (`utils.h`) is the subtle one and is used at ~100 sites across
14 modules. Its Uint8Array / ArrayBuffer / typed-array paths are JS-free, but the
**DataView** path reads `buffer` / `byteOffset` / `byteLength` with
`JS_GetPropertyStr`. Those are prototype accessors, and an **own** property on
the instance shadows them — so a hostile DataView passed as a *later* argument
runs user JS and can detach an *earlier* argument's buffer (confirmed:
`crypto.hmacSha256(key, hostileDataView)` hashed freed key memory). It now
rejects a DataView carrying an own `buffer`/`byteOffset`/`byteLength` (a genuine
one never has these), which keeps the helper JS-free for every caller. Do not
reintroduce unguarded property reads there, and treat a *sequence* of
`JS_GetAnyBuffer` calls as safe only because of that guard.

Async variants are worse: a pointer stashed in a request struct and used from a
libuv callback can be detached any time before the callback runs. Copy into
C-owned memory instead of holding a backing-store pointer across the await
(`tjs_stream_write` / `tjs_udp_send` / `tjs_file_rw` all copy — keep it that way).

Watch for *helpers* that re-enter JS without looking like it. `tjs_obj2addr`
(`circu.js/src/utils.c:52`) reads `.ip`/`.port` and converts both, so it runs up to four user
hooks (two getters, a `toString`, a `valueOf`) — resolve the address **before**
acquiring any payload pointer. `tjs_udp_send` had it backwards and sent freed
heap over the network.

### uv_run Discipline

Never call `uv_run` outside `vm.c` (main loop) and `engine.waitIO()`.
Close handles with `uv_close`; callbacks fire in `TJS_FreeRuntime` → `uv_loop_close`.
`process.waitSync()` uses `waitpid(2)` directly (libuv tolerates ECHILD).

### Worker Exit State

`TJSWorker.wrt == NULL` does **not** by itself mean the worker thread is fully
done. The worker clears `wrt` before returning because it still runs
`TJS_FreeRuntime()` during teardown. Use an explicit exited/joined state when
deciding whether the parent GC can free the worker-side bookkeeping structs.

### DynBuf Eval Length Convention

`tjs__load_file` appends **no** NUL terminator, so `dbuf.size` is exactly the
content length. `JS_Eval`/`TJS_EvalModuleContent` take the content length
(excluding the terminator), so whether `- 1` is correct depends on when
`.size` was sampled:

- sampled **before** `dbuf_putc(&dbuf, '\0')` → pass it as-is (`utils.c`)
- sampled **after** the putc → pass `.size - 1` (`modules.c:373`)

Getting this wrong truncates the last byte of every script and underflows to
`SIZE_MAX` on an empty file.

### One-Time Init & Per-Thread Statics

Module `*_init` functions run once **per context**, including on worker
threads. Any process-global one-time init inside them (e.g.
`curl_global_init`, mutex creation) must go through `uv_once` — a plain
`static int initialized` flag is a data race. Mutable file-scope state that is
logically per-runtime (console counters/timers, group indent) must be
`thread_local`; only genuinely shared state (e.g. `stdout_mutex`) stays global.
`dlmopen`/`Lmid_t` are glibc-only — guard with `__GLIBC__`, not `__linux__`
(musl builds break otherwise).

### Untrusted-Input Parser Progress

Parsers over attacker-supplied text (source maps, bjson, XML) must guarantee
the scan pointer advances every iteration. `decode_vlq` returns failure
*without* consuming the offending byte, so a `while (*p)` loop that only
`break`s out of the inner loop spins forever on a stray character. On a
malformed segment, skip to the next known separator.

### Lock File Format (SQLite3)

LockStore uses SQLite3 (`cts.lock`) with tables:
- `sources` — spec→specPath mapping (L1 cache)
- `modules` — specPath→ModuleInfo (L2 cache)
- `imports` — specPath→static import specifiers for warm `cno cache` scans
- `bins` — binary name→local path

Lock rows are authoritative and are not revalidated during resolution. Pack
uses its own `fullGraph` scanner callback and never substitutes cached imports
for the source graph being packed.

### Lock Location & Persistence (`resolveLockTarget` in runtime/index.ts)

The lock is a resolution cache, not a per-directory artifact — so it is NOT
written next to every script. `runtime/index.ts` decides its location and
read/write mode from the command:

| Case | Location | Mode |
|------|----------|------|
| `--lock-dir=<dir>` | that dir | writable under `cno cache`, else read-only |
| `cno cache` (`cfg.persistLock`) | project root (`deno.json`/`deno.jsonc`/`package.json`, walked up from the entry dir); falls back to the cache dir when no project is found | **writable — the only command that persists `cts.lock`** |
| `cno run` / `eval` / `repl` / `test` / `pack` | project-root lock if one exists, else the cache dir | **read-only** — opens the file if present, otherwise a `:memory:` DB; never writes |
| `--no-lock` (`cfg.disableLock`) | — | in-memory only |

`persistLock` is a `ConfigOptions` flag set only by `cno cache`. Read-only
stores no-op all writes (`flush`/`setModule`/…), so `runFile`'s `flushLock()`
is harmless. The lightweight read-only `new LockStore(cwd, true)` stores in
`main.ts`/`bin.ts`/`task.ts` (bin-cache lookups) are unaffected — they never
wrote to disk. Persist surface is **single-path**: `LockStore.flush` /
`ModuleResolver.flushLock` only (no separate `rewrite` / `rewriteLock` alias —
they were zero-diff dual names).

### Packed Containers (`.jspack`)

`cno pack` uses `DepScanner` in `fullGraph` mode, compiles every source under a
relocatable `pack:` identity, and records exact parent/specifier edges. Keep
these invariants when changing resolver, scanner, compiler, or cache code:

- Packing must fail on scan/compile omissions; never fall back to the pack-time
  source tree while running a container.
- Preserve query/hash identities. Alternate import-attribute views use
  `ctsview:<kind>/<encoded-spec>` via `moduleViewRef()`, never suffix tricks on
  a user-controlled specifier.
- Modules marked `sourceOnly` must set `ModuleInfo.cacheBytecode = false`.
  Serialized QuickJS modules currently lose import-attribute semantics.
- A bytecode ABI mismatch recompiles from bundled source. Extensionless entries
  therefore store their explicit language in the manifest.
- Validate manifest keys and blob ranges before load. Runtime path is
  `PackSession.open` → `install`: one map of the container, lazy
  `PackBlobStore` (0-copy `subarray`), on-demand `deserialize` — no
  `pack-extract`, no eager seed, no bytecode copies. `localPath` stays the
  synthetic `pack:` id; `isFileBackedPath` gates disk bytecode/mtime.
- Container ids are opaque keys, never filesystem paths, but they must be stored
  in `canonicalizePath` form (`\` → `/`): `ModuleResolver.resolve` canonicalizes
  every specifier before the manifest lookup, so a `\` in an id makes the module
  unreachable and reports a misleading `ModuleNotFound`. `decodePack`
  canonicalizes ids (entry, module keys, `localPath`, edge parents/targets) and
  rejects ids that collide once canonical; edge *specifier* keys stay verbatim.
  `encodePack` stays a faithful serializer so callers can build exact fixtures.
- Write the header and chunks to a same-directory temporary file, `fsync`, then
  rename (with the same destination-exists replace path). Never expose a
  partial destination or build duplicate full blobs.
  That replace path (`swapOverExisting`) parks an existing destination as
  `<out>.old-N` before renaming over it. For a **directory** destination the park
  succeeds and the cleanup `unlink` silently fails, so pack reported success
  while displacing a whole tree and leaving the litter behind. `runPack`
  therefore rejects an output path that is an existing directory up front —
  the writer cannot distinguish the two cases once it is called.
- Public pack surface (`cts` API): `writePack`, `loadPack`, `encodePack`,
  `decodePack`, and related format helpers — used by CLI and integration tests.
- `cno pack` may populate dependency caches but must not persist `cts.lock` or
  run lifecycle scripts. Only `cno cache` owns those side effects.
- Only statically discoverable imports belong to the container. Missing computed
  imports fail explicitly at runtime rather than escaping the container.
- Offline pack `edges` are built only from `DepScanner` `resolutions` (the BFS
  resolve log). Do not rebuild edges by re-scanning sources in the writer — a
  second incomplete pass (e.g. JS/TS-only) drops non-source edges. Every file
  kind that can declare static deps must be scanned the same way: JS/TS via
  ImportScanner, WASM via import-module names (`cts/src/wasm-imports.ts`).
  Host-only WASM import modules (WASI, bare `env`) are not graph edges; all
  other import module names (including path-like ones) are.
- **The eval filename is baked into the bytecode atom table, so it is part of the
  artifact.** `ParseDriver` compile targets therefore carry an explicit
  `identity` (`CompileTarget.identity`, `compileIdentity()` in `cts/src/parse.ts`)
  — the filename to compile under, which must equal the one the runtime would use
  compiling that module fresh. It defaults to `localPath` for CJS (`CjsLoader`
  evals under the host path, so on-disk `.jsc` caches must match) and `specPath`
  otherwise. **Pack overrides both with its `pack:` id.** Without the override the
  CJS default put the pack-time absolute host path into every container, leaking
  the build machine's directory layout — measured: two `C:/Users/<user>/…` atoms
  in a 6-module artifact, one per `.cjs`. The manifest JSON stayed clean, so only
  a whole-artifact byte scan catches it (`tests/cts/pack-command.test.ts:154`);
  a manifest-only assertion (`:401`) passes regardless.

### CJS external resolve miss vs rethrow (compile/bridge.ts)

`buildCjsDeps.resolveExternal` maps only resolution **misses** to `null`
(`isResolutionMiss`: `ModuleNotFound` / `FileNotFound` / `MODULE_NOT_FOUND` /
`ENOENT`) so CJS can continue the local `node_modules` walk. Non-miss kinds
(`ProtocolDisabled`, `NetworkError`, `LockFrozen`, `InvalidSpecifier`, …)
rethrow and must not be rewritten as a generic `MODULE_NOT_FOUND`.

### CJS→ESM Sync Loading (compile/bridge.ts)

`loadEsmSync` uses `engine.promiseResult` with three outcomes:
1. **Throws** → module evaluation failed → propagate as CJS require error
2. **Returns null** → top-level await unresolved → throw "cannot require() async ESM"
3. **Returns truthy** → success → return `mod.namespace` (live reference)

IMPORTANT: Returns live namespace reference, NOT a shallow copy.
Module is C++ native; `export()` bindings live in C++ memory.
A shallow copy would create dangling pointers if the Module is GC'd.
The null check must NOT be weakened by checking namespace size.

### Config Loading Priority

```
1. CLI flags (highest)
2. Environment variables (CTS_*)
3. deno.json / deno.jsonc
4. tsconfig.json
5. package.json (imports field)
6. Defaults (lowest)
```

`paths` implies `baseUrl` when `baseUrl` is absent: relative alias targets
resolve from the **config file's directory**, not the cwd (TS 4.1+ behaviour).
Applies to both `tsconfig.json` and `deno.json` `compilerOptions.paths`. An
explicit `baseUrl` may itself be absolute (`/opt/src`, `C:/proj/src`) and must
not be joined onto the config dir.

A `paths` entry is an **ordered fallback list**, not a single target: every
entry is tried in order and the first that exists on disk wins. Only when all
candidates miss is `ModuleNotFound` thrown (the message lists all of them).

### Transform Diagnostics Convention

- `cts/src/source/transform.ts` is the boundary that converts OXC/Sucrase parse failures into structured diagnostics.
- When transform code has line and column information, throw `TransformError` from `cts/src/errors.ts` instead of flattening the error into a formatted string.
- `TransformError` must carry `fileName`, `line`, and `column` so REPL, CLI, and future editors can render code frames without parsing human text.
- Callers such as the REPL should treat transform diagnostics as structured data first, and only fall back to message parsing for backward compatibility.
- **A SyntaxError is attributed exactly once.** `new engine.Module()` instantiates
  dependencies through the load hook, so a nested failure (e.g. a CJS dependency
  whose source is really ESM) surfaces out of the *importer's* `compileEsm`.
  `EsmCompiler.wrapSyntaxError` therefore passes through any error already
  carrying `.kind` or a `cause.path` — re-wrapping printed the importer's path
  and code frame for a syntax error located in a dependency.

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
│   ├── console.ts     # thin globalThis.console facade over native console
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
│   │   ├── errno-fix.ts # Windows sync-errno correction (see below)
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

**WebAPI conformance notes** (verified differentially against real Node v24.18;
`cno/src/webapi/**` is **baked into `cno.exe`** — `cno setup` only refreshes
`cno/src/node/**`, so webapi edits need `cmake -B build` to take effect. To
observe an edit without rebuilding, `await import()` the source file: each
webapi module installs its own globals as a side effect):

| Behaviour | Notes |
|---|---|
| `TextEncoder.encode` | Routes through `sanitizeSurrogates` (`utils/bytes.ts`), because `engine.encodeString` emits WTF-8 (`ed a0 80`) for a lone surrogate where the encoding spec requires U+FFFD (`ef bf bd`). `encodeInto` already did this via `nextCodePoint`. The same helper guards every wire path that stringifies user text: fetch/XHR bodies, multipart FormData, Blob parts, and WebSocket TEXT frames (RFC 6455 requires valid UTF-8 there). `node:buffer` keeps its own copy of the regexes — node modules may not import outside `cno/src/node`. |
| UTF-8 **decode** direction | The mirror bug: `engine.decodeString` is WTF-8-*tolerant*, so malformed input leaked a lone surrogate back into JS instead of U+FFFD. User-visible replacement decodes use the native `text.Decoder`; WebSocket TEXT frames and close reasons instead use fatal UTF-8 decoding and initiate protocol close 1007, as RFC 6455 §8.1 requires. `engine.decodeString` is still fine for the curl debug-trace strings and `prompt()`. `URLSearchParams` percent-decoding needed a dedicated `percentDecodeUtf8` (url.ts): the old fallback built one Latin-1 char per byte, so `k=%ED%A0%80` yielded `"í\xA0\x80"` where Node gives three U+FFFD. It percent-decodes to **bytes** first, then UTF-8 decodes. |
| `Headers` guard | `Headers.setGuard(headers, 'immutable')` makes `set`/`append`/`delete` throw, as the spec requires for `Response.error()` and `Response.redirect()`. Name/value validation runs **before** the guard check, matching spec order. |
| `Response` status | `ResponseInit.status` is WebIDL `unsigned short`: `toUint16` (truncate + mod 65536) runs **before** the 200–599 range check, so `200.7` → 200 and `65736` → 200 rather than `RangeError`. |
| `Response.text()` | Always UTF-8, ignoring the content-type charset. `XMLHttpRequest` is the one API that honours charset (`xhr.ts` keeps its own `CHARSET_RE` decode). |
| `Request` URL | The constructor parses and normalizes `input` (`http://a.com` → `http://a.com/`). It requires an explicit scheme rather than relying on `new URL`, because the URL polyfill deliberately maps bare paths (`/foo`, `C:/x`) to `file:` for path-to-URL conversion — otherwise `fetch('/foo')` would silently read the local filesystem. |
| `AbortSignal` | `any()` takes any iterable (not just an Array); `timeout()` throws `RangeError` for a negative/non-finite delay; the default reason message is `This operation was aborted`. `Symbol.toStringTag` sits on the prototype, not on each instance. |
| `TextDecoder` | An unsupported label throws `RangeError` (native `text.Decoder` raises `TypeError`). `fatal`/`ignoreBOM`/`stream:true` chunked decoding and the non-UTF-8 encodings (utf-16le, shift_jis, gbk, windows-1252) all match Node. |
| `URL` — `file:` hosts | Follows "file host state": a drive letter in host position is a path, not a host (`file://C:/x` → `file:///C:/x`; the backslash form `file://C:\x` previously threw `invalid port` because `C:` reached the authority parser), and a `localhost` host becomes the empty host. `C\|` normalizes to `C:`. This is what `tests/node/sqlite.test.ts` exercises via `new URL('file://' + winPath)`. |
| `URL` — backslash | `\` is a path separator for **special** schemes only (http/https/ws/wss/ftp/file), never in the query or fragment. |
| `URL` — opaque paths | A non-special scheme not followed by `//` (`data:`, `mailto:`, `blob:`, `javascript:`) keeps an opaque path: one verbatim string, never split or given a leading `/`, and the `pathname` setter is a no-op. Without this, `blob:http://a.com/x` was mangled to `blob:/http:/a.com/x`. |
| `TransformStream` / `TextEncoderStream` / `TextDecoderStream` | Cancelling the readable errors the writable through `writable._controller._abort`, not the public `abort()`. The public method throws `Stream is locked` while a `pipeTo` writer holds the lock, which stranded the producer and stopped `pipeThrough` from propagating cancel upstream. |
| `TransformStream` — identity & error paths | A transformer with **no** `transform` is the identity transform and must enqueue the chunk; dropping it silently lost every chunk and hung consumers on `new TransformStream()`. A throwing `transform`/`flush` must error the **readable** as well — erroring only the writable left `readable.read()` pending forever. `terminate()` closes the readable *and* errors the writable, a throwing `start()` propagates out of the constructor, and `readableType`/`writableType` throw `RangeError`. |
| `WritableStream` — rejection reason | An errored stream rejects `write()` with its **stored reason**, not a generic TypeError, so a `cancel`/`abort` cause survives to the caller. `close()` deliberately keeps the state TypeError (Node does too); only the message text differs from Node's `Invalid state: WritableStream is closed`. |
| `WritableStream` — backpressure | `writer.write()` enqueues **synchronously** and returns the write promise; it must not `await this.ready` first. Gating the enqueue on `ready` made the queue accounting lag a microtask, so `desiredSize` never dropped and `ready` never went pending — the two signals the spec uses for backpressure. Write ordering is unaffected (the controller serialises through its own `#operation` chain). |
| `ReadableStream` — `desiredSize` | Charges the controller's non-spec **side buffer** (chunks past the HWM, kept so the transport layer stays lossless) as well as the main queue, otherwise `desiredSize` floors at 0 and never reports negative pressure. `close()` must zero the side-buffer byte count when it drains it into the main queue — it did not, which double-counted those bytes. |
| `ReadableStream` — iterator lock | `values()`'s `return`/`throw` release the reader lock **synchronously**, before awaiting the cancel: QuickJS's `for await` does not await the async `return()` on `break`, so releasing behind the await left the stream locked for a whole macrotask. |
| Streams — missing surface | `ReadableStreamDefaultReader`/`DefaultController` and `WritableStreamDefaultWriter`/`DefaultController` are exposed as globals. The BYOB trio (`ReadableStreamBYOBReader`, `ReadableByteStreamController`, `ReadableStreamBYOBRequest`) is **absent because byte streams are unimplemented** — `getReader({mode:'byob'})` throws, `type:'bytes'` gives no `byobRequest`, and `autoAllocateChunkSize` is ignored. `TransformStreamDefaultController` is an object literal, so it has no constructor to expose. An invalid `mode` now throws `TypeError`, and `pipeThrough` validates the `{readable, writable}` pair. |
| `Blob` / `File` | `new Blob('ab')` throws: a bare string is iterable but is not a `BlobPart` sequence. `slice()` applies WebIDL `long long` coercion **before** the relative-index clamp, so `slice(NaN, 3)` is `slice(0,3)` and `slice(7, Infinity)` is empty. An empty Blob's `stream()` enqueues no chunk at all (a zero-length one made the first read report `done: false`). `type: null` stringifies to `"null"`, and `File.lastModified` coerces a `Date` to a number. |

`URLSearchParams`, `atob`/`btoa` (`InvalidCharacterError`), `queueMicrotask`,
`performance`, and the timer globals were checked against Node and need no
changes. `setTimeout.length` is 1 and `clearTimeout.length` is 0 — WebIDL/browser
values, deliberately not Node's.

For URL paths, `\` is a separator only under special schemes. Hierarchical
non-special schemes preserve it as literal path data (`abc://h/a\b`), including
through the `pathname` setter; query and fragment text also preserve it.

`TransformStream` **does** have readable-side backpressure, and it matches Node.
**Corrected 2026-08-01** — this section previously claimed the opposite ("no
readable-side backpressure … a `write()` settles even with no reader attached
(Node's stays pending)"). That does not reproduce. OBSERVED, same script run
against `build/stage/cno.exe` and real node v24.18.0, byte-identical output on
all eight cases:

| case | cno | node v24.18 |
|---|---|---|
| 1st `write()`, default HWM, no reader | PENDING | PENDING |
| `write()`, explicit readable `highWaterMark: 0` | PENDING | PENDING |
| `write()` #1 at readable HWM 1 | SETTLED | SETTLED |
| `write()` #2 at readable HWM 1 | PENDING | PENDING |
| `write()` with a reader attached | SETTLED | SETTLED |
| chunk still readable after a queued write | `len=3` | `len=3` |
| `writer.desiredSize` (writable side) | 1 | 1 |

So a `write()` with no reader **stays pending** exactly as Node's does, and the
HWM-1 pair shows the queue is really being charged rather than the promise being
resolved eagerly. Do not write a test that asserts the old divergence, and do not
"restore" unbounded buffering here on the strength of this paragraph's history.
Chunks remain lossless (the readable controller's side buffer is still what holds
them past the HWM — see the `desiredSize` row in the table above).

`structuredClone` preserves resizable `ArrayBuffer` metadata, accepts any iterable
transfer sequence (and rejects a non-iterable with `TypeError`), and preserves
identity for repeated built-ins. Built-in cloning reads captured prototype methods
and getters rather than shadowable instance properties: `Date`, `RegExp`, typed
arrays/DataView, `Map`/`Set`, and boxed primitives therefore clone from their
internal slots. Non-zero view offsets, shared backing buffers, circular references,
transfer-list detaching, and `DataCloneError` for unsupported objects are covered in
`tests/webapi/basic.test.ts`.


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

**Deno-compat semantics worth knowing** (verified differentially against real
Deno 2.9.3 on Windows):

| Behaviour | Notes |
|---|---|
| `Deno.errors` | All 25 upstream classes are present and match Deno exactly. |
| `Deno.Kv` / `Deno.KvListIterator` | Attached to `Deno` by `deno/kv/index.ts`; `lib.deno.d.ts` declares them as classes, so `instanceof` must work. The `Quic*` entries in `lib.deno.d.ts` are `interface`s (type-only) and intentionally have no runtime constructor. |
| `FsFile.close()` | Throws `BadResource` on an already-closed file, matching Deno. `[Symbol.dispose]` stays **idempotent** so `using` + an explicit `close()` does not throw. Internal stream teardown (EOF, `cancel`, `close`, `abort`) uses the private idempotent `$closeQuiet()` — never `close()`. |
| `FsFile.readSync` at EOF | Returns `null`. The native `fs.pread` raises `UV_ENOENT` at EOF on Windows (`ERROR_HANDLE_EOF` mistranslated); `03_fopen.ts` maps that single case to EOF. A live fd cannot genuinely be `ENOENT`, and other errno values still propagate. |
| `ENOTEMPTY` | `wrapFSErr` keeps it a plain `Error` with `code = 'ENOTEMPTY'` (as Deno does) instead of mapping to `AlreadyExists`, which would rewrite `.code` to `EEXIST`. |
| `Deno.chown` / `chownSync` | Reject with `NotSupported` on Windows. The native sync call raises a non-Deno `InternalError` and the async call silently succeeded, which would let callers believe ownership changed. |
| `Deno.Command.outputSync()` | Missing executables surface as `NotFound`/`ENOENT` via `wrapSpawnErr`; the native sync spawn reports `InternalError: CreateProcess failed: 2`. The async `spawn` path already yields `UV_ENOENT` and needs no wrapping. |
| `output()` with non-piped stdio | Throws `TypeError` — this **matches** Deno; do not "fix" it to return empty buffers. |

Known gaps: `Deno.lint` and `Deno.telemetry` are unimplemented. `Deno.run` and
`Deno.serveHttp` are deprecated upstream and deliberately absent from
`lib.deno.d.ts`.

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

**Windows stdio is forced to binary mode.** `tjs__normalize_stdio` (`vm.c`) runs
`_setmode(fd, _O_BINARY)` on each inherited fd 0/1/2. Inherited CRT descriptors
default to **text** mode, which rewrites `\n` as `\r\n` on write and strips `\r`
(stopping at Ctrl-Z) on read — that corrupted every binary write, since both
stdout paths land on a CRT fd: `console.c` uses `fwrite(..., stdout)`, and
`Deno.stdout.writeSync`/`process.stdout.write` reach `mod_fs.c`'s
`write(fd, ...)` via `utils/stdio.ts`. Measured before the fix:
`Buffer/Uint8Array [41 0a 42 0a]` came out as `41 0d 0a 42 0d 0a`. Node and Deno
never translate, so binary is also the parity-correct choice. Only descriptors
we *inherited* need this — a vacant slot is filled by opening `NUL` with
`_O_BINARY` already set. Do not call `_setmode` (or `_get_osfhandle`) on a
descriptor that may not exist: MSVCRT invokes the process-wide
invalid-parameter handler.

**node/fs/errno-fix.ts** — Windows sync-fs errno repair. `circu.js/src/mod_fs.c`
has a correct `crt2uv()` helper but ~30 call sites bypass it and use
`uv_translate_sys_error(errno)`, which expects a **Win32** error code while
`errno` is a **CRT** errno. Small CRT values therefore decode as unrelated Win32
errors. `asyncfs` is unaffected — only the sync `fs` module is wrong.

| operation | CRT errno | decoded as | native gives | Node gives |
|---|---|---|---|---|
| open `wx`/`O_EXCL` on existing | EEXIST 17 | ERROR_NOT_SAME_DEVICE | EXDEV | **EEXIST** |
| unlink/rm a directory | EPERM 1 | ERROR_INVALID_FUNCTION | EINVAL | **EPERM** |
| rmdir non-empty | ENOTEMPTY 41 | (unmapped) | UNKNOWN | **ENOTEMPTY** |
| fstat/read bad fd | EBADF 9 | (unmapped) | UNKNOWN | **EBADF** |
| readFile a directory | EACCES 13 | ERROR_INVALID_DATA | EINVAL | **EISDIR** |

`ENOENT` survives only by coincidence (Win32 2 is also ERROR_FILE_NOT_FOUND).
Corrections need the syscall + path for context, so route **every native sync fs
call** through `wrapSync`/`toSyncErrnoException` from `./errno-fix`, never the
raw `_internal/errno` versions. Do **not** apply them to `asyncfs` errors: those
codes are already right and a genuine EXDEV would be rewritten to EEXIST.
Native `fs.symlink` throws a bare localized `TypeError` with no errno, so
`fixSyncError` probes the filesystem for that case — never parse the message.

Windows sync `fs.stat` / `fstat` / `lstat` now use libuv directly. This preserves
sub-second timestamps (the former CRT `struct stat` path truncated them to whole
seconds), keeps sync and async freshness checks aligned, and gives `stat` /
`lstat` their correct follow/no-follow semantics. Do not map `uv_stat_t` back
through a CRT `struct stat`: doing so drops `tv_nsec` and makes same-second,
same-size source rewrites invisible to the bytecode cache.

**node/fs/utils.ts** — `Stats` derives `isFile()`/`isDirectory()`/… from
`mode & S_IFMT` when the native `is*` booleans are absent, because `asyncfs`
stats carry only `mode`. Internal `stat`/`rawMode` are defined non-enumerable so
`Object.keys`/spread match Node. `bigint: true` returns a distinct
`BigIntStats` (Node's class name) carrying `atimeNs`/`mtimeNs`/`ctimeNs`/
`birthtimeNs`, scaled from ms — not OS-exact nanoseconds.

**node/timers/mod.ts** — every delay goes through `normalizeDelay()`, which mirrors Node:
clamp to `[1, 2**31-1]` and `process.emitWarning` a `TimeoutOverflowWarning` /
`TimeoutNegativeWarning` / `TimeoutNaNWarning` outside it. `undefined` becomes 1 silently.
Without the clamp, delays above 2^31 are handed to the native timer and never fire.
`Timeout` exposes `_idleTimeout` / `_repeat` / `_destroyed`; a fired one-shot sets
`_destroyed = true` but keeps `_idleTimeout` so `refresh()` can revive it, while an explicit
`clearTimeout` sets `_idleTimeout = -1` and makes `refresh()` a no-op.

**node/dgram/mod.ts** — verified against Node v24.18 on Windows. Two traps.

*IP-level option numbers are not in `socket.defines`.* That module only exports
`IPPROTO_IP` / `SOL_SOCKET` / `SO_*`, so `IP_TTL` and the multicast options are
hardcoded in TS. They are ABI values: Windows and macOS/BSD agree, Linux does
not (`IP_TTL` 4 vs 2, `IP_MULTICAST_IF` 9 vs 32, membership 12/13 vs 35/36).
Getting one wrong yields `UNKNOWN`/-4094 from the raw `setsockopt`, and a
`catch {}` around it hides the failure entirely. udp6 sockets must use
`IPPROTO_IPV6` (41) with the `IPV6_*` numbers — see `ipOpt()`.

*`_bound` is not the same as "the OS socket exists".* cno passes a concrete
address family to `uv_udp_init_ex`, so its `SOCKET` is created in the
constructor; Node passes `AF_UNSPEC` and leaves it `INVALID_SOCKET` until
something binds. Socket options observe that difference, so the `_materialized`
flag tracks it separately from `_bound`. Consequences worth preserving:

| call on a never-bound socket | Node on Windows |
|---|---|
| `setTTL(64)` / `setBroadcast` / `setMulticast*` | `EBADF` (-4083) |
| `setTTL(0)`, `setMulticastTTL(256)` | `EINVAL` — libuv's `SOCKOPT_SETTER` range-checks **before** the `INVALID_SOCKET` check |
| `setMulticastTTL(-1)` | in range: `VALIDATE_MULTICAST_TTL` is -1..255, unlike TTL's 1..255 |
| `addMembership` | succeeds, and **deferred-binds** — later options and `address()` then work |
| `get/setRecvBufferSize` | `ERR_SOCKET_BUFFER_SIZE` wrapping `ENOTSOCK`, and does *not* materialize |

Zero-length datagrams are real messages: `mod_udp.c` already swallows libuv's
`nread==0 && addr==NULL` "nothing to read" case, so gate the `'message'` emit on
`result.addr`, never on `nread > 0`. The `socket` module reports setsockopt
failures on Windows as a bare `InternalError: WSA error <n>` with no code, so
`sockErrCode()` recovers the UV name from the message.

**node/net/mod.ts** — verified against Node v24.18 on Windows.

*`listen` failures are asynchronous.* Node defers a bind/listen error to
nextTick, so `server.listen(port); server.on('error', h)` — the standard
EADDRINUSE-retry idiom — still catches it. Emitting inline instead makes that
throw straight out of `listen()`. The error carries
`{code, errno, syscall:'listen', address, port}` with the message
`listen <CODE>: <desc> <address>[:<port>]` (e.g.
`listen EADDRINUSE: address already in use 127.0.0.1:49625`), and **no** own
`name` — `toErrnoException` stamps one, so `toListenError` deletes it to keep
`Object.keys(err)` matching upstream. Windows errno here is libuv's:
EADDRINUSE -4091, EACCES -4092.

*`address()` on a pipe server returns the bare path string*, not an
`AddressInfo` object — so `Server._address` is `AddressInfo | string | null`.

*Windows has no filesystem Unix-domain sockets.* libuv maps a pipe bind to
`CreateNamedPipe`, which only accepts the `\\.\pipe\` namespace; real Node fails
a tmpdir `.sock` path with `listen EACCES` on Windows too. Tests must pick the
path per platform (`pipePathFor` in `tests/node/net-socket-state.test.ts`) rather
than the code being bent to accept one. Named pipes are kernel objects — there is
nothing to `unlink` afterwards.

**node/tls/mod.ts** — `TLSSocket` extends `Duplex`, but Node's extends
`net.Socket`. It implements the whole `net.Socket` surface except `connect`, so
the only user-visible gap is `tlsSocket instanceof net.Socket === false`.
Reparenting the prototype is not a safe one-line fix: net's `_read`/`_write`
assume `_tcp`/`_stream` fields a TLSSocket does not have. This divergence is also
the root of about half the remaining `https/mod.ts` type errors.

Session/ticket accessors go through `bufferFromRaw`, because the C layer may
return a **view** into a larger buffer and `Buffer.from(view)` copies *elements*,
silently dropping `byteOffset`/`byteLength`.


routed through `process.emitWarning` (carrying `emitter`/`type`/`count`), not `console.warn`.
An unhandled non-Error `'error'` payload throws `ERR_UNHANDLED_ERROR` with the value in
`.context`. Note `_events` is a `Map` here, not Node's null-prototype object, and
`_eventsCount` is absent — npm packages that poke at those internals will not work.

**node/async_hooks/mod.ts** — `AsyncLocalStorage` keeps context in a module-level store map.
`run`/`exit` restore it synchronously (including on a thrown error), except when the callback
returns a thenable: the restore is then deferred until that thenable settles. That deferral is
load-bearing — it is the only way `await` continuations see the right store, because
`engine.promiseHook` dispatches through `JS_EnqueueJob` and so cannot restore context
synchronously. Consequences: the store leaks to code running after `run()` returns, and
concurrent overlapping `run()` calls can observe each other's store.

**node/module/mod.ts** — `Module.wrapper` is byte-identical to Node v24, *including*
the space in `(function (exports, …`; do not "fix" it to the no-space form.
The module reaches cts only through the `Symbol.for('cts.internal')` bridge, and
that bridge has no interception point, so **Node's CJS loader-hook surface is
inert**: patching `Module._load`, `Module._resolveFilename`, `require.extensions`
or `Module._extensions` changes nothing about what `require()` does (measured:
0 calls into a patched `_load`/`_resolveFilename`; a registered `.weird` handler
is never invoked and the file loads as raw bytes instead). **Re-verified
2026-08-01, and again 2026-08-02 against the 10:34 rebuild — every leg still holds**, with two details
worth having before you debug it: a `_load` that returns a substitute value has
**no effect** (`require()` still yields the real module, so the hook is not merely
unobserved, it is bypassed), and the "raw bytes" arrive wrapped as
`{ default: <byte map>, __esModule: true }` rather than as a bare `Uint8Array` —
so a `.weird` require *succeeds* and returns an object, which is easy to mistake
for the handler having run. Check the handler's own call count, not the return
value. `require.extensions`
is also a *fresh object per `mkRequire()`*, so it is neither shared between two
`createRequire()` results nor identical to `Module._extensions` — Node makes all
of them one object (measured: both identity comparisons are `false` here and
`true` in node v24.18). `require.cache` and `Module._cache` are likewise two proxies
(over the same cts map, so lookups agree but identity does not).
`register`/`registerHooks`/`syncBuiltinESMExports` are silent no-ops.
This breaks the whole require-hook ecosystem: ts-node, @babel/register,
esbuild-register, pirates, require-in-the-middle (so every APM agent —
OpenTelemetry, Datadog, New Relic), module-alias, tsconfig-paths/register,
mock-require, proxyquire. A fix needs cts to own a single shared extensions
registry consulted by `CjsLoader.exec`, plus settable resolve/load hooks on the
bridge — not more polyfill surface in this file.

**node/_internal/deep-equal.ts** — one function backs `assert.deepEqual`,
`assert.deepStrictEqual` and `util.isDeepStrictEqual`, and the two modes are *not*
strict-plus-a-flag. Verified against Node v24.18:

| case | loose (`deepEqual`) | strict (`deepStrictEqual`) |
|---|---|---|
| prototype identity | **ignored** (`Object.create(null)` == `{}`, `new Foo()` == `{}`) | compared |
| object *kind* | compared in both (`[]` != `{}`, `Error` != `{message}`, `Uint8Array` != `Int8Array`) | compared |
| primitives | SameValueZero, then `==` (`NaN` == `NaN`, `1` == `'1'`) | `Object.is` |
| typed arrays | element-wise `==` (`F64[-0]`==`F64[0]`, `F64[NaN]`!=`F64[NaN]`) | raw bytes (opposite result for both) |
| symbol keys | ignored | compared |
| boxed vs bare | never equal (`new Number(1)` != `1`) | never equal |

Both modes compare only **enumerable** own properties, so a non-enumerable
property never makes two objects unequal. That is why `Error` needs an explicit
`name`/`message` comparison — those two are non-enumerable, so key-walking alone
would report `new Error('x')` == `new Error('y')`. `Map` keys need a structural
fallback for the same reason `Set` members do: `Map.has()` is reference-based, so
`new Map([[{x:1},1]])` would otherwise not equal an identical literal.

**node/crypto/** — `getHashes()` lists `shake128`/`shake256` **without** a dash,
matching Node; the dashed spelling is still accepted as *input* to
`hash()`/`createHash()` because `normalizeHashAlgorithm` strips dashes. Node's
`Hash` throws `ERR_CRYPTO_HASH_FINALIZED` on digest-after-digest, but `Hmac`
does **not** — it returns empty output, because OpenSSL frees the context on the
first `final()`. Validation that Node performs *eagerly* must not be deferred
into the callback: `pbkdf2`, `scrypt`, `hkdf` and `generateKeyPair` all throw
synchronously for a bad digest/params/curve/type and only defer the derivation
itself. `scrypt` also needs OpenSSL's own memory budget checked in JS
(`128*r*p + 128*r*(N+2) > maxmem` → `ERR_CRYPTO_INVALID_SCRYPT_PARAMS`),
otherwise the C layer surfaces a bare `RangeError` with no `.code`.

**node/child_process/mod.ts** — verified against Node v24.18 on Windows.

Failure shapes are load-bearing (packages branch on them):
- `exec`/`execFile` callback error: `Command failed: <cmd>\n<stderr>` carrying
  `code` (exit status, or `null` when signalled, or the string errno for a spawn
  failure), `killed`, `signal`, `cmd`.
- `execSync`/`execFileSync` throw an Error decorated with the whole spawnSync
  result — `status`/`signal`/`output`/`pid`/`stdout`/`stderr`.
- A spawn that never starts emits `'error'` **then `'close'` with the UV errno as
  the exit code, and no `'exit'`** (`_failSpawn`). Without that `close`,
  `exec()` of a missing binary never calls back. `syscall` is `spawn <cmd>`.
- `send()` never throws synchronously on a write failure: it returns `false` and
  reports via the callback, or emits `'error'` when there is none.

Encoding defaults follow Node, not utf8: `spawnSync`/`execSync`/`execFileSync`
return **Buffers** unless an explicit non-`'buffer'` encoding is given.
`spawnSync` enforces `maxBuffer` after the fact (`ENOBUFS`, output truncated) —
the C call runs to completion, so Node's kill-mid-stream is unreachable, and
`timeout`/`killSignal` cannot be honoured there at all.

The ENOENT pre-flight (`getImmediateSpawnError`) exists because native
`spawnSync` throws a bare `InternalError` (`"CreateProcess failed: 2"`) with no
`code`/`errno` — never parse that message, probe the filesystem. It must be
**PATHEXT-aware**: Windows `CreateProcess` appends `.EXE`/`.COM`/`.BAT`/`.CMD`,
so an extensionless absolute path like `D:/build/stage/cno` is legitimate and the
native spawn runs it. A plain `fs.exists` check rejects it and fabricates ENOENT
for a binary that works — a Windows-only trap for the POSIX-idiomatic
extensionless path, silently fine on Linux/macOS. Only an extensionless final
segment gets the PATHEXT probe; bare names (no separator) skip the pre-flight
entirely and let the native PATH search resolve them.

That skip leaves a second hole, because native `spawnSync` reports an
unresolvable **bare** name as the same codeless `InternalError`: `spawnSync`
returned `code`/`errno`/`syscall` all `undefined` where Node gives
`ENOENT`/`-4058`/`spawnSync <cmd>`. Async `spawn` is unaffected — the native
async path does throw a proper `-4058`. `normalizeSpawnFailure` closes it on the
**failure path only**: when a native spawn error carries no usable errno, resolve
PATH+PATHEXT in JS and synthesize ENOENT only if the command genuinely does not
resolve. Keep this off the success path — a JS PATH search that disagrees with
CreateProcess would reject commands that actually run, which is the same class of
bug as the extensionless one above.

Windows resolution facts worth not re-deriving (all measured against Node):
`CreateProcess` resolves a bare name against the **parent's** PATH, so a `PATH`
passed via `options.env` does *not* affect lookup — Node returns ENOENT there
too, so this is Windows semantics, not a defect.

**CVE-2024-27980 — a direct `.bat`/`.cmd` spawn is refused (BREAKING).**
`cmd.exe` re-parses a batch file's argument string, so a `&` in any argument runs
as a separate command. Confirmed exploitable, not theoretical: spawning a `.bat`
that echoes `args=[%*]` with the argument `a" & echo INJECTED & rem "b` printed
`args=["a\"]` and then `INJECTED` **on its own line, outside the brackets** —
i.e. `cmd.exe` executed it. libuv's `quote_cmd_arg()` cannot prevent this because
`cmd.exe` undoes that quoting, and the native layer exposes no
`windowsVerbatimArguments`. `spawn`/`spawnSync` therefore reject it
(`isBatchFileCommand`), matching Node's hardening.

- The guard lives in **TS, not the native layer**: `buildShellInvocation`
  rewrites command/args to `cmd.exe /d /s /c …` for `shell: true`, so by the time
  `tjs_spawn` runs, `options.file` is already `cmd.exe` and the "asked for a
  shell" vs "spawned a `.bat`" distinction the fix depends on is gone. Node makes
  the same choice (`normalizeSpawnArguments`, not C++).
- Covers every entry point: `execFile`/`fork` delegate to `spawn`,
  `execFileSync` to `spawnSync`. `exec`/`execSync` are **exempt** because they
  pass `shell: options?.shell ?? true` — exactly how Node exempts them.
- **`shell: true` is the escape hatch** (measured: the batch file runs and the
  argument stays one literal token). `windowsVerbatimArguments: true` is *not* —
  Node rejects that too, and here it would not help anyway.
- Error shapes match Node v24.18 exactly: `spawnSync` **returns**
  `error` = `spawnSync <cmd> EINVAL` with `code`/`errno`/`syscall`/`path`/
  `spawnargs` (status/signal `null`); async `spawn` **throws synchronously** a
  bare `spawn EINVAL` whose own keys are exactly `errno`/`code`/`syscall`. Node
  defers only ENOENT to `'error'`, never EINVAL. `errno` comes from
  `nativeError.errno.EINVAL` (**runtime −4071** on Windows; note
  `circu.js/types/error.d.ts` declares the literal `-4075`, which is wrong).
- The check runs on the **PATHEXT-resolved** name, not the raw string, so
  `spawn('D:/tools/build')` cannot slip through when the probe lands on
  `build.bat`. One deliberate divergence: for an extensionless path where *only*
  a `.bat` exists, Node reports ENOENT and this reports EINVAL. Harmless —
  measured, `CreateProcess` appends only `.exe`, so that path never executed
  anyway (`CreateProcess failed: 2`), and PATHEXT order puts `.EXE` before
  `.BAT`, so a directory holding both still resolves to the `.exe`.
- Breaking change: callers that spawn a `.bat`/`.cmd` directly now fail. Nothing
  in-tree did. Fix such a caller with `shell: true`, not by relaxing the guard.

`kill(0)` is a liveness probe: it must not arm the killed-guard and must never
fall through to the native SIGTERM default. `'overlapped'` stdio is a pipe.
`windowsHide` maps to the native `background` flag and defaults to **false**
(Node's v11 change to `true` was reverted). An already-aborted `AbortSignal`
kills immediately; Node always builds its own `AbortError`/`ABORT_ERR` and
ignores `signal.reason`.

Windows `shell:` quoting — Node sets `windowsVerbatimArguments` so libuv hands
the command line to CreateProcess untouched. The native layer exposes no such
flag, so libuv's `quote_cmd_arg()` rewrites every inner `"` to `\"`, which
cmd.exe then passes through literally and the command arrives mangled. Neither
caret escaping nor argv splitting can defeat this (both measured). The
workaround, when and only when the command contains a quote, is to pass it via
the `CNO_INTERNAL_SHELL_COMMAND` env var and run `cmd /d /s /c call %VAR%`:
libuv never sees a quote, and `call` restores the second expansion pass so
`%VAR%` references still expand. Verified equal to Node for quotes, `&&`, `||`,
pipes, redirection and exit-code propagation. Do not drop the `call` — without
it `%VAR%` in the user's command stops expanding.

**node/cluster/mod.ts** — a **stub**, not an implementation. `fork()` throws, so
`workers` is permanently `{}` and no worker ever exists; real forking needs
handle passing over IPC (`SCM_RIGHTS` / `WSADuplicateSocket`), which the host IPC
channel does not implement. `Worker` is exported as a constructor purely so
`instanceof`/prototype probes do not hit a missing export. `schedulingPolicy`
follows Node: `SCHED_NONE` on Windows, `SCHED_RR` elsewhere, overridden by
`NODE_CLUSTER_SCHED_POLICY=rr|none`. Known divergence: Node's `setupPrimary`
normalizes `settings` to always include `exec`/`args`/`execArgv`/`silent`; this
stub keeps the caller's keys verbatim.

**node/sqlite/mod.ts** — `location` is a **prototype method**, `location(dbName?)`,
matching Node v24.18 and `@types/node`. **BREAKING**: it used to be a readonly
`string` own property, so `db.location` is now a function — any existing caller
reading it as a string gets `[object Function]`. Nothing in-tree did.

The native binding exposes **no filename accessor** (`Sqlite3Handle` has no
`sqlite3_db_filename` equivalent), so the value is **emulated**: `path.resolve` on
the normalized path, captured at `open()` time — not lazily. `os.cwd` is a live
accessor, so reading it inside `location()` would let a later `os.chdir` change
what an already-open database reports, which Node never does. Measured contract:
absolute with native separators; `undefined`/`'main'` agree; `'temp'` and unknown
schemas are `null`; `:memory:` and `''` are `null`; the **open check precedes the
arg-type check**, so a closed db with a bad argument gives `ERR_INVALID_STATE`
(plain `Error`, `'database is not open'`) and not `ERR_INVALID_ARG_TYPE`
(`TypeError`); `location.length === 0`.

Two divergences emulation cannot close:
- After `ATTACH`, `location('aux')` returns the attached file's real path in Node
  but `null` here — a **wrong** answer, not merely a missing one.
- Absolute-path expansion is SQLite's win32 VFS. `path.resolve` matches the common
  case but drifts on UNC paths, `\\?\` prefixes and drive-relative forms (`C:foo`).

`normalizeLocation` keeps **percent-decoding** for `file:` URLs on purpose. Node's
`DatabaseSync` decodes `%2F` and opens the file, while `fileURLToPath` throws
`ERR_INVALID_FILE_URL_PATH` on the identical input — `DatabaseSync` hands the URL
to SQLite's own URI parser (`file://otherhost/C:/x.db` → `ERR_SQLITE_ERROR:
invalid uri authority: otherhost`, a SQLite message). Do **not** give it
`fileURLToPath` semantics. A non-`file:` URL throws `ERR_INVALID_URL_SCHEME`
(`The URL must be of scheme file:`). The URL pathname's leading slash is stripped
before a drive letter (`/C:/x` → `C:/x`); Windows tolerated the old `/C:/…` form,
so that bug was latent.

`native.open` never passes `O_URI`, so a `file:`-prefixed **string** is treated as
a literal filename and `file::memory:` fails with "unable to open database file"
(pre-existing, unrelated to `location`). `location()` still returns `null` for a
`file:` prefix, which is what Node reports when URI mode does open one.

**node/zlib/mod.ts** — `TransformCallback` must match
`Transform.prototype._transform`/`_flush` in `../stream` **exactly**
(`(error?: Error | null, result?: Buffer)`). Typing the first parameter as
`unknown` is not merely loose — it is *unassignable* by contravariance
(`unknown` is not `Error | null | undefined`), which silently broke all 18
`_transform`/`_flush` prototype assignments across the 9 stream classes. The
three `catch` sites therefore route through the existing `asError()` helper,
which is also what Node's streams require: `destroy(err)` expects a real `Error`.

`brotli` is in `TJSOptionalModules`, so `import.meta.use('brotli')` is typed
`| null` and needs `?? {}` — the `try`/`catch` alone does not cover it, because a
missing optional module returns `null` rather than throwing. `_create`'s
parameter must carry the same `& TransformOptions` its `ZlibStreamCtor` declares,
since the options object reaches the constructor verbatim.

The direction-specific `ZlibDeflateHandle`/`ZlibInflateHandle` split (narrowed by
`isDeflateHandle`, not by the separately tracked `state.compress` flag) exists
because the native handles are one-way: `createDeflate`/`createGzip`/
`createDeflateRaw` expose only `deflate` (plus `params`), the rest only
`inflate`. Note the native `zlib.d.ts` declares these returning **`ArrayBuffer`**
while the local handle types say `Uint8Array`; every call site wraps in
`Buffer.from(...)`, which accepts both, so this does not surface as an error —
but do not "simplify" a wrapper away.

**node/os/mod.ts** — `os.constants.errno` holds **platform** errno, not libuv's.
On Unix libuv codes are `-(platform errno)`, so `Math.abs` recovers them, but on
Windows libuv uses its own `-4095…` band and `Math.abs(UV_EACCES)` gives `4092`
where Node reports `13`. Windows therefore needs the explicit `WIN32_ERRNO`
table (134 entries, including the `WSA*` block at 10000+); do not "simplify" it
back to a single `Math.abs` map. libuv-only names with no platform errno
(`EOF`, `ECHARSET`, `EAI_*`, `ENONET`, …) are filtered out because Node does not
expose them here either. Also Windows-specific: `dlopen` is `{}` (RTLD_* are
POSIX), `devNull` is lowercase `\\.\nul`, and `UV_UDP_REUSEADDR` is 4 on every
platform.

`networkInterfaces()` derives `cidr` from the netmask (`netmaskPrefix`) — the
native layer supplies no `cidr` field, and defaulting to `/32`/`/128` reports a
wrong prefix for every normal subnet. A non-contiguous mask yields `null`, as
Node does. Node also installs `Symbol.toPrimitive` on **all fourteen** zero-arg
getters (`arch`, `availableParallelism`, `endianness`, `freemem`, `homedir`,
`hostname`, `machine`, `platform`, `release`, `tmpdir`, `totalmem`, `type`,
`uptime`, `version`), so `${os.homedir}` works without the call.

Native `os` exposes **no** `getPriority`/`setPriority`, so `os.getPriority()`
always returns 0 and `setPriority()` silently does nothing; only the range
validation is real.

**node/tty/mod.ts** — `getColorDepth` mirrors Node's `internal/tty.js` exactly,
and on **Windows it never consults `TERM`** (except `dumb`): it keys off the OS
build number (>= 14931 → 24-bit, >= 10586 → 256). A `TERM`-based heuristic
reports 4 where Node reports 24. `FORCE_COLOR` maps `''`/`1`/`true`→4, `2`→8,
`3`→24 and **anything else→2**; `NO_COLOR` must be **non-empty** to disable, and
`NODE_DISABLE_COLORS` merely has to be defined.

`hasColors()` with no count defaults to **16**, so it returns *false* under
`NO_COLOR`. Returning `true` unconditionally is the bug that makes every
colour-detecting package emit ANSI into a plain pipe. A count below 2 throws
`ERR_OUT_OF_RANGE` and a non-integer `ERR_INVALID_ARG_TYPE`.

`ReadStream`/`WriteStream` track their own teardown in `ttyClosed`, **not**
`closed`: `closed` is a getter on `Readable`/`Writable.prototype` reading
`_readableState`/`_writableState`, and a private field of that name shadows it,
so `stream.closed` would flip at `destroy()` instead of at the `'close'` event.

**node/readline/mod.ts** — `history` is **newest-first** (`history[0]` is the
last line entered), matching Node; `_moveHistory` indexes it directly. A
consecutive repeat is **always** collapsed regardless of options, while
`removeHistoryDuplicates` (default **false**, not true) additionally removes
every *earlier* occurrence. `historySize: 0` disables history entirely rather
than making it unbounded.

`terminal` — not the OS raw-mode flag — selects line editing and history
(`_processInput`), so `terminal: true` over a plain stream behaves like Node's.
The TTY mode change is scoped to `input === stdin`: readline used to flip the
**process-wide** stdin into raw mode even when handed an unrelated stream, and
then restore it on a `close()` it did not own.

Prompts are written **synchronously** when the output queue is idle
(`_scheduleWrite`), because Node's `question()` shows its prompt before the
answer callback runs; a purely queued write emits it after. Public surface Node
has and this module now matches: a `terminal` property, `cursor`, and
`getCursorPos()` (`getTerminal()`/`cursorPos` remain as pre-existing aliases).

**node/console/mod.ts** — `Console` delegates all formatting to `node:util`
(`format`/`inspect`). The former hand-rolled formatter floored `%d` (4.7→4),
emitted `{a: 1}` without inner spaces, JSON-stringified `%o`/`%O`, and turned
`%c` into real ANSI; ~230 lines of it are gone. Do not reintroduce a local
formatter. `console.table` is a port of Node's `cliTable`: real `┬┼┴`
junctions, **left**-aligned cells, one `Values` column for primitives, and
`util.inspect`ed cells (so strings are quoted) — verified byte-identical.

`trace()` writes **one** message to **stderr**, `Trace: <formatted>` followed by
the caller's frames (`slice(2)` drops the Error header *and* this method's own
frame). `assert()` adds the colon only when the first extra argument is a string
(`Assertion failed: msg` vs `Assertion failed { a: 1 }`). Group indentation
applies to **every** line of a multi-line message. `timeEnd`/`timeLog` switch
units at 1 s and 60 s (`0.005ms` / `1.200s` / `1:05.000 (min:sec.ms)`).

Timers and counters are per-instance `Map`s, so they die with the `Console` —
the C layer's `console_counters`/`console_timers` `thread_local` lists
(`console.c`) have no TS-side counterpart and no teardown hook.

**node/repl/mod.ts** — **real, but thin**, not a stub. `_eval` runs through
`vm.runInContext` against a `vm.createContext()`, because a bare indirect `eval`
cannot persist declarations: `const x = 5` then `x*2` threw "x is not defined".
`'line'` handling is serialised through `_lineQueue`, since an async evaluation
otherwise lets a later synchronous command's output overtake it. `.help` pads
names to `longest + 3` and ends with the Ctrl-C/Ctrl-D hint. Still missing
versus Node: multi-line continuation UX (the `Recoverable` plumbing exists but
nothing produces one), completion wiring beyond a user-supplied `completer`, and
`setupHistory` persistence (it reports success without writing a file).

**node/console/mod.ts + the native `console.format` split** — `util.format` is
correct on every case measured against v24.18; the **native** C `format` is not,
and the two diverge in exactly three places:

| args | `util.format` | native `format` | Node |
|---|---|---|---|
| `('a%%b')` | `a%%b` | `a%b` | `a%%b` |
| `('err-path %%')` | `err-path %%` | `err-path %` | `err-path %%` |
| `({a:1},[1,2])` | `{ a: 1 } [ 1, 2 ]` | `{ a: 1 } [1, 2]` | `{ a: 1 } [ 1, 2 ]` |

Node returns a **lone string argument unchanged** (an `args.length === 1`
short-circuit before any specifier scanning), so `%%` is an escape only when
further arguments follow; the native routine escapes unconditionally. It also
omits the inner spaces in an inspected array. So anything that formats through
the native console mangles `%%` and array spacing — this silently corrupted
probe output across a whole audit session, since probe labels are printed with
`console.log`.

`node:console` therefore routes **everything** through `util`: `formatOutput`
and `buildOutput` both call `utilFormat`, and `forward()` dispatches the
module-level `log`/`error`/… through a lazily built `Console` bound to
`process.stdout`/`stderr` (which is what Node's `console` module is). That also
gives the module-level methods shared group-indent and timer/counter state.
`moduleConsole()` returns `undefined` when `process.stdout` is not yet usable and
`forward()` then falls back to native, then to `globalThis.console`, so worker
threads keep working (measured).

**`globalThis.console` is NOT this module.** It is the thin facade in
`cno/src/webapi/console.ts`, which delegates every method to
`import.meta.use('console')`; the node polyfill never overrides it. So bare
`console.log('a%%b')` still prints `a%b` regardless of anything in `node:console`.
Real Node's global console *is* its `console` module instance, so that facade
design is itself the divergence — pre-formatting in TS cannot fix it, because
handing native a lone pre-formatted string re-triggers the same collapse.

**node/util + node/string_decoder** — differentially verified against Node
v24.18 on Windows. Rules that are easy to regress:

- `util.format` is **correct**. Node returns a lone string argument **unchanged**
  (`args.length === 1` short-circuit), so `console.log('a%%b')` must print
  `a%%b`; the *native* `console.format` collapses it to `a%b`.
  **Stale reference removed:** this bullet used to blame
  `node/console/mod.ts:276` for "calling the native `nativeConsole.format`
  instead of `util.format`". That is no longer true and the line number never
  pointed at a formatter — `cno/src/node/console/mod.ts` now contains **zero**
  occurrences of `nativeConsole.format` (`formatOutput`, the `format()` method
  and the exported `format` all call `utilFormat`), and line 276 is the `clear()`
  method. The `node:console` fix is described under "node/console/mod.ts + the
  native `console.format` split" above; the residual divergence is
  `globalThis.console`, which is the `cno/src/webapi/console.ts` facade, not this
  module.
- `%s` uses Node's `hasBuiltInToString` (`cno/src/node/util/inspect.ts:1837-1849`),
  whose built-in set is the `globalThis` own names matching
  `/^[A-Z][a-zA-Z0-9]+$/`. **The "all-caps names such as `URL` deliberately fail
  that pattern" explanation that used to sit here was wrong** — OBSERVED 2026-08-04
  in both cno and node v24.18: `/^[A-Z][a-zA-Z0-9]+$/.test('URL')` is `true`, `URL`
  **is** in the built-in set, and the predicate's prototype walk lands on
  `URL.prototype` / `String.prototype` with an in-set constructor for *both*
  `new URL(...)` and `new String('x')`. The predicate therefore cannot be what
  distinguishes them. The *outcome* is real and cno matches node byte-for-byte
  (`%s` → `http://a.com/` for a URL, `[String: 'x']` for a boxed string) — just do
  not re-derive it from the regex.
- **Divergence found while checking the above** (OBSERVED 2026-08-04):
  `util.inspect(new URL('http://a.com/'))` returns the bare `http://a.com/` in cno
  but a full `URL { href, origin, protocol, … }` dump (12 keys) in node, because
  node's URL carries a `Symbol.for('nodejs.util.inspect.custom')` method and cno's
  does not (`CUSTOM in url` → `true` in node, `false` in cno). `%s` agrees anyway;
  anything that inspects a URL *directly* does not.
- `inspect` never brackets a symbol key: `[…]` marks
  `enumerable === false` only, applied *after* the name is built. An own
  **enumerable** `Symbol.toStringTag` also suppresses the `Object [Tag]` prefix
  (else the tag prints twice); the check flips to `hasOwnProperty` under
  `showHidden`, and reading the tag is wrapped in try/catch for throwing getters.
- `getSystemErrorName`/`getSystemErrorMessage` never return `undefined` — an
  unmapped code yields `Unknown system error <n>`. Windows errno is **libuv's**
  (`ENOENT` is `-4058`), and `UNKNOWN` (`-4094`) **is** in `getSystemErrorMap()`;
  only `OK` is excluded.
- `styleText` emits opens in array order and **prepends** closes so they unwind
  in reverse (`['bold','underline']` → `ESC[1m ESC[4m x ESC[24m ESC[22m`).
  Wrapping iteratively reverses both and is wrong.
- `promisify` copies **all** own property descriptors from the original and
  inherits its prototype, so `name`/`length`/attached metadata survive.
- `parseArgs` applies **no** `=` splitting to short options (`-a=1` with
  `type:'string'` yields the value `"=1"`). `-abc` expands to `-a -b -c` when the
  first short is not `type:'string'`; a string-typed short in the middle takes
  the rest as its value (`-abfFILE` → `-a -b -fFILE`). Grouped tokens all report
  the **original** arg's index.

`_internal/buffer.ts` owns `utf8DecodeReplace`, the WHATWG UTF-8 decoder used
for malformed input. It exists because **no** native primitive is correct:
`engine.decodeString` is WTF-8-tolerant (leaks lone surrogates), and the `text`
Decoder / `TextDecoder` get the error *granularity* wrong in both directions — a
truncated 4-byte lead swallows the next byte (`F1 41` → one U+FFFD, losing the
`A`), while `F1 80 80 41` emits three U+FFFD where the spec's maximal-subpart
rule requires one. `algorithm.bytesIsUtf8` gates it, so well-formed input (which
cannot encode a surrogate) keeps the fast native path and only malformed bytes
pay for the per-byte scan. `node/buffer/mod.ts` and `node:string_decoder` both
import this helper; do not fork the malformed-byte algorithm again.

`StringDecoder.utf8TrailingBytes` withholds a trailing partial **only when it is
still a valid prefix**: it rejects invalid leads (`C0`/`C1`/`F5`..`FF`), verifies
the second byte against the lead's range (`E0`→`A0..BF`, `ED`→`80..9F`,
`F0`→`90..BF`, `F4`→`80..8F`), and withholds nothing when no lead byte is found.
Buffering an already-broken sequence collapses Node's error count — `80 80` must
yield **two** U+FFFD, not one. `ascii` must go through
`algorithm.asciiDecodeLoose` (Node masks the high bit: `0xFF` → `U+007F`), not
the WHATWG Decoder, which would replace it with U+FFFD.

`StringDecoder`'s public shape matches Node: a plain `encoding` own property
(canonical name, so `binary` → `latin1` and `''` → `utf8`), an unknown encoding
throws `ERR_UNKNOWN_ENCODING`, and calling it **without `new` throws** (Node's is
a strict-mode function assigning to `this`). The undocumented legacy getters
`lastNeed`/`lastTotal`/`lastChar` are derived from `_pending`. Known cosmetic
gap: for a held utf16le high surrogate Node's `lastChar` reads `[0,0,0,0]` while
this reports the real bytes; `lastNeed`/`lastTotal` agree.

**`node/ipc_channel`** is a real implementation, not a stub — newline-delimited
JSON framing plus an `advanced` (v8-serialize) path, `MessageDecoder` +
`IPCChannel`, a tier-aware buffering cap, and `NODE_*` control-message filtering
kept off the user `'message'` stream. It is cno-internal (no Node counterpart),
and the framing is wire-compatible with a real node process over
`NODE_CHANNEL_FD`.


**node/vm/mod.ts** — verified differentially against Node v24.18 on Windows;
regression coverage lives in `tests/node/vm.test.ts` (**66** `Deno.test` cases,
counted 2026-08-01; the file has no `t.step` subtests, so that is the whole
count — it was documented as 63). `Script`
compiles **eagerly** (`produceBytecode` in the constructor) so a `SyntaxError`
surfaces from `new vm.Script(...)` as Node does, and that same bytecode backs
`createCachedData`/`produceCachedData`.

Three measured traps:

- **`timeout` is a *run* option only.** Node does **not** validate it in the
  `Script` constructor or in `compileFunction` — `new vm.Script('1', {timeout: 0})`
  is accepted. `validateCompileOptions` covers filename/offset/cached-data fields;
  only `validateRunOptions` adds the timeout range check (`>= 1 && <= 4294967295`,
  `ERR_OUT_OF_RANGE`; non-number is `ERR_INVALID_ARG_TYPE`).
- **`timeout` is validated but never enforced.** There is no interrupt hook, so
  `runInNewContext('while(true){}', {}, {timeout: 300})` runs forever where Node
  throws `ERR_SCRIPT_EXECUTION_TIMEOUT` (~321 ms measured). Never put an
  unbounded loop in a test on the strength of a `timeout` option.
- **`cachedDataRejected` cannot match Node, because Node's verdict is not an
  integrity check.** V8's source hash covers only the source **length**, so Node
  reports `rejected: false` for a truncated, zeroed, empty or byte-flipped cache
  and happily *executes the stale code* (cached `'"AAA"'` ran in place of
  `'"BBB"'`); it reports `true` only when the source length differs. This module
  compares bytecode equality instead, so it answers `true` for garbage — arguably
  better, but a divergence. Only "valid ⇒ false" and "different-length source ⇒
  true" are safe to assert. Beware when probing this: consuming a mismatched
  cache poisons V8's isolate compilation cache for that source string, so every
  later case in the same process reads wrong.

`applyOffsets` pads the source with newlines/spaces because QuickJS has no offset
knob. Lines land exactly where Node puts them; **columns** only agree when
`lineOffset` is 0, since QuickJS reports one extra column on lines >= 2 for any
eval'd code (reproduced with a bare `eval`, so it is an engine trait, not this
module's). Assert column *deltas* at `lineOffset: 0`, never absolute columns
(Node 7 vs QuickJS 10 for the same source).

A compile error's realm differs by entry point, and cno matches Node exactly:
`Script`/`runInThisContext`/`compileFunction` throw a host-realm `SyntaxError`
(`instanceof` true), while `runInNewContext`/`runInContext` compile inside the
sandbox so the error is **cross-realm** — `name` is `SyntaxError` but
`instanceof SyntaxError` is `false`. Runtime errors from a new context are
cross-realm too. Do not "fix" a test to use `instanceof` on those paths.
`compileFunction` reports `name === ''` and `length === params.length` on every
path (Node's values; `'anonymous'`/`0` is the bug). Remaining gap:
`createContext(constants.DONT_CONTEXTIFY)` returns a mirrored `{}` whose
intrinsics are installed on the sandbox global, so `'Math' in ctx` is `false`
where Node's real global object gives `true`.

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

**Type declarations** (`http/types/`): **33** `.d.ts` files for circu.js native modules
(OBSERVED 2026-08-01 via `ls http/types/*.d.ts | wc -l`; the previous "30" plus a
29-name list was wrong in both directions):
`algorithm`, `asyncfs`, `bjson`, `brotli`, `console`, `crypto`, `curl`, `debug`,
`dns`, `engine`, `error`, `ffi`, `fs`, `fswatch`, `http`, `index`, `nodeapi`, `os`,
`process`, `signals`, `socket`, `sourcemap`, `sqlite3`, `ssl`, `streams`, `text`,
`timers`, `udp`, `wasm`, `win32`, `worker`, `xml`, `zlib`.
Note `jsonc` was listed before but **there is no `http/types/jsonc.d.ts`**, and
`bjson`, `brotli`, `debug`, `index` and `nodeapi` were all missing from the list.

**HTTP/2 extension** (`http/ext-h2/`): `http2.d.ts` — nghttp2 `Session` wrapper types.

**Utilities** (`http/utils/`): `assert.ts`.

### Design Principles
- **NO WebAPI types**: Does not use URL, Headers, Request, Response
- **Raw bytes + callbacks**: All I/O via `Uint8Array` and callbacks
- **CNO wrapping**: `cno/src/webapi/fetch/` maps WebAPI to this layer

Current note: standard fetch requests are curl-backed. The raw socket layer
is primarily for long-lived protocol transports such as SSE/WebSocket.

**Server HTTP/2**: `http/src/server.ts` registers `h2` when `h2Available()`;
TLS contexts advertise ALPN from `config.protocols` (`defaultAlpnProtocols`).
`Deno.serve` with `cert`+`key` offers `[HTTP2, HTTP11]` when ext-h2 is linked;
cleartext remains HTTP/1.1 only. `node:http2.createSecureServer` uses
`tls` + ALPN `h2` and steals the completed `TLSSocket` into `TcpSocket`
(with `sslPipe`) for nghttp2. Missing native H2 fails closed (no silent H1).

### Resource limits (defaults; overridable via `ServerConfig` — but NOT via `node:http`)

**The "all overridable" heading used to be unqualified and that is misleading.**
`ServerConfig.maxHeaderSize` is real and *is* honoured by the `http/` layer
(`http/src/server.ts:194` `config.maxHeaderSize ?? 16384` → `http/src/h1.ts:974` passes it into
`H1ServerConnection`). But the `node:http` surface **ignores it**: `maxHeaderSize`
is a plain `export const maxHeaderSize = 16384` in `cno/src/node/http/mod.ts:27`,
and the option accepted by `http.createServer({ maxHeaderSize })` never reaches
the h1 config. OBSERVED 2026-08-01 — server created with `maxHeaderSize: 2048`,
then probed with increasing header padding:

| header padding | cno | node v24.18 |
|---|---|---|
| 1,000 B | 200 OK | 200 OK |
| 3,000 B | **200 OK** — option ignored | **431** — option honoured |
| 15,000 B | **200 OK** | 431 |
| 17,000 B | 431 | 431 |

So cno's effective boundary stays at the hardcoded 16384 regardless of what you
pass. If you need a smaller head budget, construct the `http/` server directly with
a `ServerConfig`; do not expect `node:http` options to do it. (`http.maxHeaderSize`
reads 16384 in both runtimes, so the module-level value is not the divergence.)

`maxHeaderSize` (default 16384, Node's `http.maxHeaderSize`) bounds the whole H1
request head — request line plus every field name and value — charged incrementally
in `h1.ts` as llhttp emits it, because `maxHeadersCount` is only consulted at
`onHeadersComplete` and an endless header block never reaches it. Overflow answers
`431 Request Header Fields Too Large` and pauses the parser; the same budget covers
trailers, so an overflow after the handler started fails the body rather than
leaving it awaiting a completion callback that can no longer arrive.
`formatHead`/`formatPairs` (`h1-frame.ts`) reject CR/LF/NUL with `ERR_INVALID_CHAR`
in the start line as well as in header pairs — a handler-supplied reason phrase is
attacker-influenced and would otherwise split the response.

HTTP/2 (`h2.ts`): nghttp2 is constructed without an `nghttp2_option`, so
auto-WINDOW_UPDATE stays on and `session.consume()` is rejected — there is no
transport backpressure. Server streams therefore cap undelivered body bytes at
`MAX_BUFFERED_BODY_BYTES` (16 MiB) and RST with `FLOW_CONTROL_ERROR`; the count
drops as `bodyChunks()` yields, so a handler that keeps reading can stream any size.
Client streams are exempt — they have no incremental read API (`buildMessage()`
merges the whole response), so a cap there would only limit legitimate downloads.
Both client and server announce `SETTINGS_MAX_HEADER_LIST_SIZE` (65535).
The cap is load-bearing only because `ServerHttp2Stream.pumpBody`
(`cno/src/node/http2/mod.ts`) parks on `push() === false` instead of draining
unconditionally — OBSERVED: the default `readableHighWaterMark` is 16384 and `push()`
reports backpressure on the first 16 KiB chunk, so unread bytes stay in
`H2Stream.chunks` where the cap can see them. Draining regardless would keep
`buffered` near zero and relocate unbounded growth into the `Readable`. `acceptData`
early-returns on an already-failed/closed stream: without that a peer ignoring
RST_STREAM re-fills the discarded buffer and trips the cap again once per 16 MiB.
Note `server.ts` hardcodes `maxConcurrentStreams: 100`, so the per-connection
aggregate is ~1.6 GiB, not 16 MiB. Coverage: `tests/webapi/h2-body-cap.test.ts`
(stubs `H2Connection`, so it runs even when `h2Available()` is false).

### Which copy of `@cnojs/http` runs (three copies exist)

`http/` is a submodule, and edits reach the runtime by different routes depending on
who imports it. Getting this wrong makes a change look broken when it is simply not
loaded:

| Importer | Resolves to | Refresh needed |
|---|---|---|
| A script/test doing `import '@cnojs/http/h2'` | `node_modules/@cnojs/http` → **Junction** → `http/` | none, edits are instant |
| cno node polyfills under `$CTS_CACHE_DIR/node/**` | `$CTS_CACHE_DIR/npm/@cnojs/http@<ver>/` | `cno setup` (it *does* sync http/; `installLocalHttpToStore`) |
| Anything in the **bundle graph** (`Deno.serve`, `webapi/*`, `src/inspector/*`, `cts`) | statically inlined into `dist/cno-cli.js`, baked into `cno.exe` | full rebuild — the store does **not** override it |

**Row 1 is a Junction, not a POSIX symlink**, created from `"@cnojs/http":
"workspace:./http"` (`package.json:27`). OBSERVED 2026-08-04: PowerShell reports
`LinkType=Junction` for all three of `node_modules/@cnojs/http`,
`cts/node_modules/@cnojs/http` and `cno/node_modules/@cnojs/http`, each targeting
`<repo>/http`. That is why a direct import needs no refresh at all.

**Row 3 is why "`http/` is live" is only half true.** `scripts/bundle.mjs` sets
`bundle: true` with **no `external` list**, so esbuild follows that same Junction
and copies `http/src` *into* the bundle. OBSERVED 2026-08-04 in `dist/cno-cli.js`:
8 occurrences of `MAX_BUFFERED_BODY_BYTES`, 4 of `chargeHeaderBytes`, 4 of
`H1ServerConnection`. Every baked importer therefore runs a build-time snapshot of
`http/src`: `cno/src/deno/{05_net,07_http,08_serve}.ts`,
`cno/src/webapi/{sse,websocket}.ts`, `src/inspector/worker/server.ts`,
`cts/src/runtime/resources.ts`, and `cno/src/node/_internal/inject.ts` (the one
`node/**` file that is baked, per the "Before You Begin" note).

**Row 2's store is a version-keyed content *copy*, and it goes stale silently.**
`installLocalHttpToStore` (`src/commands/setup.ts:235-247`) writes
`<cacheDir>/npm/@cnojs/http@<version from http/package.json>/`, so bumping
`http/package.json` moves the whole store path and leaves the old tree behind.
OBSERVED 2026-08-04: `http/package.json` is at **1.1.0** while the default
`~/.cts/npm/@cnojs/` still contains only **`http@1.0.0`** (dated Jul 28) — a cache
that predates the bump serves a `@cnojs/http` from a different release. `node:http`,
`node:http2`, `node:https`, `node:net` and `node/_internal/http-client.ts` all
resolve through this row.

OBSERVED 2026-08-01, re-measured 2026-08-02 against the 10:34 rebuild: the
resource limits above **are**
active in `build/stage/cno.exe`. `grep -a -c` on the binary finds
`MAX_BUFFERED_BODY_BYTES`, `chargeHeaderBytes`, `maxHeaderSize` and
`Request Header Fields Too Large` (1 each — note `grep -c` counts *lines*, and a
binary is effectively one line, so "1" means **present**, not "once"; use
`grep -a -o … | wc -l` when you need a real occurrence count), and the `node:http`
server path
enforces them behaviourally: a 17,000-byte header field is answered
`HTTP/1.1 431 Request Header Fields Too Large` while a 15,000-byte one gets
`200 OK` — i.e. the cap trips at the documented 16384 default.

A previous revision of this file asserted OBSERVED that the binary contained
**zero** occurrences of those three symbols, and concluded the limits were dead
code pending a rebuild. That was a **measurement artifact, not a fact**: it was
produced with `strings cno.exe | grep -c …`, and **`strings` does not exist in
this MSYS environment** (`which strings` → not found). With stderr swallowed by
`2>/dev/null`, the pipeline fed grep an empty stream and every count came back 0.
Two lessons worth keeping:
- Search the binary with `grep -a -c <token> build/stage/cno.exe` — no `strings`,
  no pipe, and it works on a Release binary with attached bytecode.
- A suspiciously round zero across *every* probe is a broken tool, not a
  discovery. Confirm the harness on a token that must be present (e.g. `cno`,
  `ERR_REQUIRE_ASYNC_MODULE`) before believing an absence.

Verify `http/` internals by importing them directly (that path is live); anything
reached through `node:http` reflects the **last build**, so compare your file's
mtime against `build/stage/cno.exe` before concluding an edit is inert.
`cno setup` copies *from* `http/`, so it never clobbers local edits.
`scripts/sync-http-store.sh` refreshes only the store when you do not want `cno setup`
to also overwrite `$CTS_CACHE_DIR/node/**` from `cno/src/node/**`.

`server.ts` must not write to stdout: the "Server listening on …" line is now
`dbg('http.conn', …)`, since an unrequested line is one Node does not emit and it
corrupts any program consuming cno's stdout as data.

TLS handshakes have a 30s deadline (`socket.ts`), since the request timeout only
starts after the handshake and a stalled one otherwise pins an fd forever. Concurrent
`TcpSocket.write` calls are serialised through a promise chain — interleaving
`sslPipe.write`/`flushOutput` across awaits corrupts the record stream.

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

**Does not build on Windows/MSVC** (default is `OFF`, and no build script turns
it on). Two independent blockers, both in vendored headers:
1. `quicly/include/quicly.h:29` includes `<netinet/in.h>` unguarded — confirmed,
   it sits directly under `#ifndef quicly_h` / `extern "C"` with no platform
   guard. `ext-quic/CMakeLists.txt` supplies **no** Windows shim for it: the file
   contains zero occurrences of `windows-compat`, and `_QUICLY_INCLUDES` (set at
   `CMakeLists.txt:64-65`) is just `${_QUICLY_SRC}/include` plus the picotls dirs.
   A `deps/quicly/windows-compat/` directory does not exist in the pinned
   submodule (quicly `ed83c7c`) either. *Correction: this used to claim
   `CMakeLists.txt:85` adds a `${_QUICLY}/windows-compat/include` path that is
   merely missing on disk. Line 85 is the `endif()` of the QuickJS-not-found
   check, and no such `include_directories` entry exists anywhere in the file —
   so the blocker is a **missing shim that was never wired up**, not a broken
   path. Do not go looking for a stale include path to repair.*
2. Defining `_WINDOWS` (so `picotls.h:29` pulls in `wincompat.h` for the
   `__attribute__`/`__thread`/`ssize_t` GCC-isms) then breaks libuv:
   `wincompat.h:5` does `#define ssize_t int`, a **macro**, which turns
   `uv/win.h:27`'s `typedef intptr_t ssize_t;` into `typedef intptr_t int;`
   (C2628). native.h includes quicly before uv, so the order cannot be dodged.

Consequence for auditing: QUIC defects are **latent on Windows** — the code is
not in `cno.exe` — but live on POSIX builds that enable the flag. Do not treat a
Windows test pass as evidence about QUIC.

### Usage
- `cno/src/webapi/webtransport.ts` — WebTransport API
- `cno/src/deno/10_quic.ts` — `Deno.connectQuic` / `Deno.QuicEndpoint`

### TLS peer verification & trust store

`native.c` `js_sock_ctor` defaults `verifyPeer` to **1** for client sockets and
wires `s->tls.verify_certificate = &s->verify_cert.super`. Servers never verify
(no client-cert support). The store comes from
`ptls_openssl_init_verify_certificate(&s->verify_cert, NULL)`; the `NULL` makes
picotls call `ptls_openssl_create_default_certificate_store()`, which only
registers OpenSSL's **compile-time default paths** (`X509_FILETYPE_DEFAULT`,
overridable at runtime by `SSL_CERT_FILE` / `SSL_CERT_DIR`).

That store is **empty on Windows**: this build links vcpkg OpenSSL 3.6.3, whose
OPENSSLDIR is `C:\Program Files\Common Files\SSL`, and neither `\certs` nor
`\cert.pem` exists there. `X509_LOOKUP_load_file`'s return value is ignored, so
init still "succeeds" and every handshake then fails closed with
`X509_V_ERR_UNABLE_TO_GET_ISSUER_CERT` → `PTLS_ALERT_UNKNOWN_CA`. This is the
same trap documented for `node:tls` — see "TLS trust store" in `cno/src/node/tls/mod.ts`.

Therefore **both JS callers must pass the OS trust store explicitly** as
`caCerts` (PEM strings, added to the store on top of the default paths, so
POSIX is unaffected). `cno/src/utils/ca-certs.ts` owns that probe —
`systemCaCerts()` / `withSystemCaCerts(userCerts)`, Windows via
`win32.exportCerts('ROOT'|'CA')`, else the conventional bundle paths. Do not
"simplify" a caller back to relying on OpenSSL's defaults.

Hostname verification is handled by picotls, not here: `verify_cert_chain` calls
`X509_VERIFY_PARAM_set1_host` (or `set1_ip_asc`) with the `server_name` passed
to `quicly_connect`. `js_sock_connect` uses `argv[2] ?? host`, so passing a
bare IP as `host` with no explicit server name checks the cert against that IP.

---

## Module 6: ext-oxc — OXC Native Transpiler Extension

**Location**: `ext-oxc/`
**Language**: Rust (Cargo) + C (CMake glue)
**Purpose**: Native OXC-based TS/JSX transpiler, loaded as `import.meta.register('oxc', extPath)`

### Build
- Built alongside main project by `build.sh` / `build.ps1`
- Produces `oxc.so` (Unix) or `oxc.dll` (Windows)
- `cts/src/oxc.ts` provides the TypeScript interface (`OxcTranspiler`)
- For a staged local build, configure the root build with
  `-DCNO_EXT_DIR=<repo>/ext-oxc/build`; otherwise
  `build/stage/ext/oxc.{so,dll}` can remain stale — or, as happened on
  2026-08-01, be **absent while a perfectly good DLL sits in
  `ext-oxc/build-portable/`**. Nothing copies it for you.
  A known-good Windows recipe using a portable Rust toolchain (no writes to
  `%USERPROFILE%`) is kept at `/c/rust-portable/build-oxc.bat`: vcvars64, then
  `PATH`/`CARGO_HOME`/`RUSTUP_HOME` pointed at `/c/rust-portable`, ninja,
  `-DCJS_DIR=<repo>/circu.js -DCNO_IMPLIB=<repo>/build/circu.js/deps/quickjs/qjs.lib`.
  Cargo build ~1m41s. The DLL links `JS_*` from `qjs.dll` at load time, so it only
  needs re-doing if QuickJS itself is rebuilt.

**Requires a Rust toolchain** (`cargo` + `rustc`). `src/lib.rs` is the whole
transpiler; there is no C-only fallback, and no prebuilt binary is vendored or
published. `ext-oxc/CMakeLists.txt` is NOT referenced by the root
`CMakeLists.txt`, so a plain `cmake -B build && cmake --build build` silently
produces **no** `oxc.*`. Only the root `build.sh` / `build.ps1` build it, and even
then the result is dropped in `ext-oxc/build*/` — **copying it to
`build/stage/ext/oxc.dll` is a separate step that nothing automates.** Confirm the
file is there; `DEBUG=oxc cno run x.ts` prints
`[oxc] loaded cjs-ext-oxc 0.1.0 (oxc)` when it is really live.

When it is missing, `cts` degrades to interpreted Sucrase — ~340x slower on a
cold cache (measured: 89 s vs 262 ms with oxc for `import('node:fs')`) **and not
semantically equivalent**. The bundled Sucrase implements no decorator and no
value-`namespace` transform (measured, `cts/src/source/transform.ts`):

| TS input | Sucrase output | Result | with oxc |
|---|---|---|---|
| `@dec class A {}` | emitted **verbatim** | hard `SyntaxError: unexpected token in expression: '@'` — QuickJS has no decorator support. Exit 1. The code frame blames the user's file, which is valid TS. | **still fails identically** |
| `class A { m(@dec x) {} }` | — | `TransformError: Unexpected token` | still fails |
| `namespace N { export const x = 1 }` | `";"` | silently erased; every use becomes a runtime `ReferenceError: N is not defined`, attributed to the *consumer*, not the namespace | **fixed** |
| `declare namespace N {}` | erased | correct (type-only) | correct |
| `enum` / `export enum` | IIFE / `var E = E \|\| {}` | works; differs from tsc but runtime-equivalent | correct |

So value namespaces need `oxc.dll`; **decorators do not work either way.** With oxc
loaded, `@dec class A {}` still throws the same `SyntaxError` — the cause is
upstream in the binding, not the fallback: `ext-oxc/src/lib.rs:289` passes
`TransformOptions::default()` and there is no decorator handling anywhere in that
file. Enabling oxc's decorator transform there and rebuilding the DLL would close
it, and that needs **no** cno rebuild. Until then, treat decorators as unsupported
and say so rather than blaming Sucrase.
(Namespace/enum rows measured under the 08-01 binary with oxc loaded.)

`cno setup` **guarantees** that cold state every time: `runSetup` ends with
`clearJsc(dstBase)` and `copyTreeIfNewer` unlinks `<file>.jsc`/`.jsc.mt` per
copied file. So the very first import after a setup pays the full cold cost —
~262 ms with `oxc.dll` present, ~89 s without. With oxc the two questions below
are much less urgent, but they still describe real behaviour:

- Should `setup` warm the cache it just cleared (e.g. an internal
  `import('node:fs')`, or `precacheFromSpecifiers` over the polyfill roots)? It
  would move the 89 s from a confused user's first `cno test` into the command
  that caused it. Cost: `setup` stops being a pure file-copy.
- `runFile` only precaches under `--precache`/`--reload` (`src/commands/run.ts`),
  so plain `cno run`/`cno test` never reaches the worker-parallel transform path
  in `runPrecache` (`cts/src/runtime/index.ts`) and transforms serially on the
  main thread. Gating on "cache is cold for this graph" rather than on an
  explicit flag would fix the common case; gating on the flag is right when the
  cache is warm, since the scan is pure overhead then.

Build inputs: `-DCJS_DIR=<repo>/circu.js` (needs `src/tjs.h` +
`deps/quickjs/quickjs.h`), CMake >= 3.20, and network access on first configure
(FetchContent pulls Corrosion v0.6; Cargo pulls 92 pinned crates).

**Windows implib**: the module resolves `JS_*` from the host at load time. On
Windows `BUILD_SHARED_LIBS` is forced ON for QuickJS, so those symbols live in
`qjs.dll` — `-DCNO_IMPLIB` must be
`build/circu.js/deps/quickjs/qjs.lib`. `cjs.lib` (from `cjs-cli`
`ENABLE_EXPORTS`) exports only `TJS_*` and will not satisfy the link; the
`cno.lib` named in `ext-oxc/README.md` and the `circu.js/{Release,Debug}/cjs.lib`
path in the root `build.ps1` are both wrong. `binding.c` calls only `JS_*`, so
`qjs.lib` alone is sufficient.

---

## Build System

### CMake Build Flow

```bash
cmake -B build -DCMAKE_BUILD_TYPE=Release
cmake --build build
```

### Windows Build Recipe (this host)

The bare `cmake --build build` above is the portable form. On this box three extra
things are load-bearing, and none of them is discoverable from a failure message.

1. **MSVC env must come from `vcvars64` inside a `.bat`.** Sourcing it from the
   MSYS/bash side does not carry the environment into the build — put `vcvars64`
   and the build command in one `.bat` and run that. Neither `build.ps1` nor
   `build.sh` does this for you; the only committed vcvars recipe anywhere is the
   ext-oxc one at `/c/rust-portable/build-oxc.bat`.
2. **A running `cno.exe` is locked, so staging cannot overwrite it — park and
   swap.** Rename the live binary aside and let the build stage a fresh one. Never
   delete or write over `build/stage/cno.exe` while anything might still be holding
   it. The convention is visible in `build/stage/` itself: OBSERVED 2026-08-04 it
   holds 11 `cno.exe.inuse-<HHMM>`, 8 `cno.exe.old-locked[-N]` and a
   `cno.exe.parked-*` copy beside the current binary. **Treat every `.parked-*` /
   `.inuse-*` / `.old-locked*` file as read-only** — another agent's run may still
   be executing one.
3. **`Permission denied` during the staging copy is NOT a build failure.** It means
   the compile and link succeeded and only the final copy over a locked `cno.exe`
   lost. Park the binary and re-run staging; do not go hunting for a compile error
   and do not conclude the tree is broken.

Corollary for verification: a zero exit from the build command proves the *command*
succeeded, not that the new binary is in place. `md5sum` the staged `cno.exe`
against the copy you parked — if they match, the swap silently did not happen.

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

### What a change requires: baked vs refreshed

Which trees are frozen into `cno.exe` and which are read live is the single most
expensive thing to get wrong here — it makes a correct fix look inert, or a stale
one look fixed. OBSERVED 2026-08-04:

| Tree | How it reaches the runtime | To see your edit |
|---|---|---|
| `src/**` (incl. `src/inspector/**`) | esbuild → `dist/cno-cli.js` → cjsc → `cno.exe` | full rebuild |
| `cts/**` | same bundle | full rebuild |
| `cno/src/webapi/**`, `cno/src/deno/**` | same bundle | full rebuild |
| `cno/src/node/_internal/inject.ts` | same bundle — the exception in its own tree | full rebuild |
| `circu.js/**` (C) | compiled into the binary | full rebuild |
| `cno/src/node/**` (everything else) | copied to `$CTS_CACHE_DIR/node/**` | `cno setup` |
| `http/**` | **both**: inlined into the bundle *and* copied to `$CTS_CACHE_DIR/npm/@cnojs/http@<ver>/`, *and* live via Junction for a direct `import '@cnojs/http/…'` | depends on the importer — see "Which copy of `@cnojs/http` runs" |
| `tests/**` | read from disk | nothing |

Two consequences worth stating plainly:

- **`cno setup` refreshes `cno/src/node/**` only** (`src/commands/setup.ts:187`
  copies `src/node` / `cno/src/node`), plus the `@cnojs/http` store. It does **not**
  touch `webapi/`, `deno/`, `cts/` or `src/`.
- A test that **imports a module directly** exercises the working tree even when the
  same code is also baked. That is the basis of the recipe under "Verifying inspector
  changes without a rebuild", and it works for `http/` too.

### pnpm Workspace

No `pnpm-workspace.yaml` — workspace packages are resolved via `workspace:` protocol in `package.json` dependency fields:
- `cno-cli` → `cts` (workspace:./cts), `@cnojs/http` (workspace:./http)
- `cts` → `@cnojs/http` (workspace:../http)

### Package Dependencies

```
cno-cli (root)
  ├── @cnojs/http (workspace:./http)
  ├── cts (workspace:./cts)
  └── node-buffer, ts-interface-checker

cts
  ├── @cnojs/http (workspace:../http)
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
cno pack <file> [-o x.jspack] # Build a portable module container
cno setup                   # Install Node.js polyfill files to cache
cno --version               # Version
cno --help                  # Help
```

### CLI Flags

```bash
--cache-dir=<path>      # Cache directory (default: ~/.cts)
--lock-dir=<path>       # Override cts.lock dir (default: project root on `cno cache`, else cache dir)
--no-lock               # Disable lock file (in-memory only)
--frozen                # Fail if import not in lock
--reload, -r            # Bypass module cache
--precache              # Pre-cache dependencies
--cached-only           # Refuse network downloads
--ignore-scripts        # Skip npm lifecycle scripts (`cno cache`)
--no-http               # Disable http/https imports
--no-jsr                # Disable jsr: imports
--no-node               # Disable Node.js compat
--no-oxc                # Disable OXC native acceleration
--silent, -q            # Silent mode
--disable-cache         # Disable all caching
--memory-limit=<size>   # e.g. 256MB, 1GB — MAIN THREAD ONLY, see below
--max-stack-size=<size> # e.g. 4MB — same caveat
--polyfill=<path>       # Custom polyfill bundle
--npm-mode=<normal|soft|hard>  # Materialize real node_modules (cno cache); see resolve/linker.ts
--out=<path>, -o <path>    # cno pack output; must end in .jspack
--ext=<lang>               # Language override for an extensionless entry / `-` stdin
--env=<path>, --env-file=<path>  # Load env files before the entry (repeatable)
--preload=<module>         # Evaluate a module before the entry (repeatable)
--require, --import=<mod>  # Node-style preload; NODE_OPTIONS entries come first
--location=<url>           # globalThis.location
--conditions, -C=<list>    # Extra package.json export conditions
--print, -p                # Print the eval result (implies the eval subcommand)
--concurrency=<n>, --filter=<substr>, --fail-fast, --permit-no-files  # cno test
--system-proxy, --skip-cert-verify  # network
```

`src/help.ts` is the user-facing copy of this list; keep the two in step. The
help text renders colour from `os.STDOUT_FILENO` (**not** stdin) so
`cno --help > file` stays clean.

### `--memory-limit` / `--max-stack-size` — main thread only

These were advertised in `--help` and parsed by `parseArgv` but **never mapped
into the runtime config**, so a `--memory-limit=16MB` run happily allocated
gigabytes. The main-thread half is now fixed and enforced; **workers still ignore
the flag.** OBSERVED 2026-08-01 on `build/stage/cno.exe`, allocating 1 MB slices
up to 500 MB in the main thread and again inside a `node:worker_threads` Worker:

| invocation | main thread | worker |
|---|---|---|
| `--memory-limit=16MB` | **refused at 8 MB** (`InternalError: out of memory`) | **allocated all 500 MB** — flag not propagated |
| `CTS_MEMORY_LIMIT=16MB` (env) | refused at 8 MB | **refused at 8 MB** — env *is* propagated |
| no limit given | allocated all 500 MB | allocated all 500 MB |

So **`CTS_MEMORY_LIMIT` is the working workaround** when a worker must be capped;
the CLI flag is not a substitute. Do not describe either flag as a sandbox or an
OOM guard for worker-parallel work (precompile transform workers included).

**With no flag, the limit is unlimited, not 1 GB.** `TIER_MEM_LIMIT`
(`cts/src/config.ts:31-35`) is `low: 32MB`, `normal: 256MB`, `high: 0` — and `0`
means unlimited, so on a large-memory box (32 GB here) the default is no cap at
all. A guess of "1 GB by default" is wrong in the dangerous direction.

### NODE_OPTIONS Tokenizer (`src/commands/run.ts`)

`splitNodeOptions` must mirror node's `ParseNodeOptionsEnvVar`, which is **not**
POSIX shell splitting. Verified differentially against node v24.18 by round-
tripping `--title` through a real child (24 cases):

| NODE_OPTIONS | node token value |
|---|---|
| `a\b` | `a\b` — `\` is **literal** outside double quotes |
| `a\\b` | `a\\b` — including a doubled one |
| `"a\b"` | `ab` — inside double quotes it escapes the next char |
| `"a\"b"` | `a"b` — so an escaped quote does not close the string |
| `a'b` | `a'b` — `'` is **not** a quote character |
| `'a b'` | `'a` — so it does not protect the space |

**The only separator is the space character.** Tab, newline, CR, VT and FF all
stay inside the token: `--a<TAB>--b` is a single option name and node rejects it
as `--a<TAB>--b is not allowed in NODE_OPTIONS`. Splitting on `\t`/`\n` invents
tokens node never produces.

Treating `\` as an escape everywhere (and `'` as a quote) broke every unquoted
Windows path: `NODE_OPTIONS=--require C:\tmp\x.cjs` became `C:tmpx.cjs` and the
preload failed with MODULE_NOT_FOUND while real node loaded it fine.

Malformed quoted input is rejected before preloads run: an unterminated `"`
reports `invalid value for NODE_OPTIONS (unterminated string)`, while a trailing
escape inside a quote reports `(invalid escape)`, matching node's tokenizer.

Malformed NODE_OPTIONS is parsed at the start of `runFile`, before env/config
loading, inspector attachment, or runtime creation. Do not move validation back
into preload execution: an invalid process option must have no startup side effects.

`nodeExecArgv` puts NODE_OPTIONS entries **before** the CLI's own `--require`
/`--import`, matching node's precedence.

### Deno-compat No-op Flags

```bash
--allow-net, --allow-read, --allow-write, ...  # Permissions (always granted)
--unstable, --unstable-*, ...                   # Unstable features (ignored)
--check, --no-check                             # Type checking (ignored)
--import-map, --config                          # Config (cts uses own)
```

The `--allow-*`, `--deny-*` and `--unstable-*` groups are matched as **prefix
families**, not an enumerated list (`isDenoNoopFlag` in `src/cli.ts`), so a flag
Deno adds later is still accepted silently instead of warning. Anything else
unrecognised warns once and is ignored.

> **Permissions are NOT a security boundary — there is no enforcement at all.**
>
> `--allow-*` is accepted and `Deno.permissions` answers queries, but nothing
> gates the operations. `cno/src/deno/00_permission.ts` is 146 lines of
> `PermissionStatus`/`Permissions` plumbing plus name validation; it contains no
> `checkRead`/`checkWrite`/`checkNet` and no `PermissionDenied` path.
>
> Measured with **no `--allow-read` flag at all** (where real Deno denies by
> default), reading `C:/Windows/win.ini`:
>
> | path | result |
> |---|---|
> | `Deno.readTextFileSync` | ALLOWED (92 bytes) |
> | `node:fs` `readFileSync` | ALLOWED (92 bytes) |
> | `import.meta.use('fs')` raw | ALLOWED |
>
> `--allow-read=<other-dir>` gives identical results, so scoping is inert too,
> and `Deno.permissions.query()` returns `"granted"` for arbitrary paths and
> hosts. Do **not** rely on any `--allow-*` flag to sandbox untrusted code, and
> do not treat a `query()` result as meaningful.
>
> Enforcing this later belongs at the **native layer** (`mod_fs.c`,
> `mod_socket.c`, `mod_process.c`), not in the TS wrappers: `Deno.*`, `node:*`
> and `import.meta.use()` all reach the same primitives, so a wrapper-level gate
> is bypassed by the low-level API that AGENT.md elsewhere encourages using.

### Value-Flag Discipline (`src/cli.ts`)

Two rules keep a mistyped flag from silently changing behaviour:

- **`--` is never a value.** `shouldConsumeValueFlagToken` rejects it, so
  `run --cache-dir -- main.ts` leaves `cache-dir` bare and keeps `main.ts` as
  the entry. Swallowing it assigned the nonsense value `"--"` *and* lost the
  terminator — `test --filter -- a_test.ts` filtered on `"--"` and ran zero
  tests at exit 0. Deno and node both reject this ("a value is required for
  `--config <FILE>`").
- **A missing value is an error, not a default.** Every consumer type-guards on
  `typeof flags[k] === 'string'`, so a flag arriving as `true` is silently
  dropped. `missingFlagValues()` lists the offenders from `REQUIRED_VALUE_FLAGS`
  and `dispatch` exits 1. Deliberately excluded: `out`/`o` (pack prints its own
  `-o/--out requires a file path`), `eval` (bare `task --eval` is a documented
  usage error) and `v8-flags` (deno accepts the bare form).

### Inspector Flags

```bash
--inspect[=host:]port   # Enable CDP inspector
--inspect-brk[=port]    # Enable inspector, break on first line
--inspect-wait[=port]   # Enable inspector, wait for client before running
```

`cno test` runs **one child process per test file** and forwards every flag, so
an inspect flag makes every child after the first die with `EADDRINUSE` on the
single fixed port. `runTest` therefore forces `concurrency = 1` whenever any
`--inspect*` is present, the same way `--fail-fast` already does.

---

## Environment Variables

| Variable | Description |
|----------|-------------|
| `CTS_EXT_PATH` | Native extensions directory |
| `CTS_CACHE_DIR` | Cache directory override |
| `CTS_LOCK_DIR` | Lock file directory |
| `CTS_SILENT` | Silent output (true/false) |
| `DEBUG` | Debug categories — 33 of them, plus `*` and `!cat` negation. See "Debug Categories" below; the short list that used to sit here was incomplete |
| `CTS_DISABLE_CACHE` | Disable cache (true/false) |
| `CTS_ENABLE_HTTP` | Enable http imports (true/false) |
| `CTS_ENABLE_JSR` | Enable jsr imports (true/false) |
| `CTS_ENABLE_NODE` | Enable node compat (true/false) |
| `CTS_MEMORY_LIMIT` | Memory limit (e.g. 1GB). **Propagates into workers, unlike `--memory-limit`** — see the flag section above |
| `CTS_MAX_STACK_SIZE` | Max stack size (same worker caveat as `--max-stack-size`) |
| `CTS_NO_OXC` / `CTS_ENABLE_OXC` | Disable / enable OXC acceleration (true/false) |
| `CTS_JSR_CACHE_TTL` | JSR metadata cache lifetime, in days |
| `CTS_REQUEST_TIMEOUT` | Registry/remote fetch timeout, ms |
| `CTS_JSX_PRAGMA` / `CTS_JSX_FRAGMENT_PRAGMA` | JSX factory overrides |
| `CTS_WORKERS` | Precompile worker count (`0` = inline; otherwise explicit worker count) |
| `NODE_OPTIONS` | Node preload flags (`--require`/`--import`), applied **before** the CLI's own |
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
| `src/commands/pack.ts` | `runPack` — build validated portable `.jspack` containers |
| `src/commands/setup.ts` | `runSetup` — install Node.js polyfill files |
| `src/commands/inspect.ts` | `parseInspectFlags` — --inspect flag parser |
| `src/commands/bin.ts` | `spawnBinary` — resolve and spawn node_modules binaries, pnpm-liked direct runner |

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

**Inspector endpoint security** (`worker/server.ts`) — mirrors the real node inspector:

- `/json`, `/json/list`, `/json/version` are served **unauthenticated**. They must be: a client
  learns the ws URL *and* its token by reading `/json/version`, so gating discovery on that same
  token is unsatisfiable and makes every DevTools client (and the `cdp-*` tests) fail.
- The DNS-rebinding defense is `Host` header validation, not secrecy of the discovery JSON. Only
  IP literals, `localhost`, and the configured bind hostname are accepted; anything else gets
  `400`. A browser cannot forge `Host`, so a domain rebound to 127.0.0.1 is rejected. Real node
  behaves identically (`Host: evil.com` → 400). **Every** `Host`/`Origin` occurrence is checked,
  not a last-wins map lookup: the H1 parser rejects duplicate `Content-Length` but not duplicate
  `Host`, so `Host: evil.com` + `Host: 127.0.0.1` must fail closed.
- The WS upgrade keeps two extra gates: the random per-process `token` (query param or
  `x-cdp-token`, compared with `safeEqual`) and an `Origin` check. A DevTools frontend sends no
  `Origin`; a cross-origin `Origin` is rejected with `403` so a rebound page cannot drive the
  debugger (which is arbitrary code execution).
- Header names are lowercased before lookup: the H1 parser already lowercases, but the H2 path
  (`http/src/server.ts`) preserves the sent case.
- `devtoolsFrontendUrl` **must carry the token** in its `ws=` value. It is the URL
  `chrome://inspect` actually opens, and the upgrade is token-gated, so omitting the token makes
  every "inspect" click `403` while `/json` still looks healthy. A literal `?` inside a query
  value is legal (RFC 3986) and `URLSearchParams.get('ws')` returns it intact, so `ws` is kept
  last and unencoded. `tests/node/cdp-endpoint.test.ts` pins this.
- `respondJson` sends **no CORS headers**, and must not gain any. Unauthenticated discovery is
  only safe because a cross-origin page cannot *read* the response; an
  `Access-Control-Allow-Origin` here would let any web page lift the token.
- The token is the **entire** security model together with the bind address: `--allow-*` is not
  enforced (bookkeeping only), so nothing backs it up. It is `crypto.randomUUID()` (uv_random →
  CSPRNG, 122 bits) compared with a constant-time `safeEqual`. A non-loopback bind is warned about
  at attach time (`isLoopbackHost`, `main/inspector.ts`) because discovery hands the token to
  anyone who can reach the port.

**Fire-and-forget RPC** — use `WorkerEndpoint.notify(...)`, never `void rpc.call(...)`. An orphan
rejected promise reaches the worker's `unhandledrejection` listener (`worker/bootstrap.ts`), which
reports it to the main thread as a *worker crash*. Since `PipeClient` now rejects everything
in flight when the pipe faults, a dying pipe would otherwise manufacture a phantom crash report
per outstanding call.

**Transport failure contract** — a transport that can no longer reply must reject what is
outstanding, never leave it pending: a pending CDP command shows in DevTools as a spinner with no
error. `ChannelClient.setActive(false)` does this across a resume; `PipeClient.failAllPending`
does it on `onmessageerror`.

**Inspector process lifetime** — the debug worker's `messagePipe` stays referenced while the
entry is loading and while `--inspect-brk` / `--inspect-wait` perform their startup waits. Once
the entry settles, `runFile` calls `Inspector.allowProcessExit()`, which `unref()`s that pipe.
The inspector therefore remains usable while another referenced server/timer keeps the program
alive, but it cannot by itself pin a completed program or strand `main.ts`'s nonzero
`process.exitCode` idle-exit poll. Do not move the `unref()` into `attach()` — doing so can let an
inspect-wait process exit before a client connects. `detach()` still terminates the worker for
the REPL and programmatic `inspector.close()` paths.

**Transport** (`transport/`): `MainEndpoint` + `WorkerEndpoint` (RPC facades),
`PipeClient`/`PipeServer` (async uv MessagePipe), `ChannelClient`/`ChannelServer` (sync native DebugChannel).

**CDP Domains** (`domains/`): `DebuggerDomain` (breakpoints, pause/resume state machine),
`RuntimeDomain` (evaluate, execution context, bindings), `ConsoleDomain` (buffered console messages),
`NetworkDomain` (fetch/serve/WebSocket → CDP Network.*), `FetchDomain` (request interception),
`PageDomain` (frame lifecycle), `TargetDomain` (target listing), `side-effect.ts` (safe eval analysis).

**Shared** (`shared/`): `cdp.ts` (CDP type definitions), `wire.ts` (WorkerEvent/PipeMsg enums),
`rpc-contract.ts` (RpcParams source of truth, transport routing), `native.ts` (debug module bindings),
`user-files.ts` (isUserFile), `console-utils.ts` (consoleAPICalled helpers).

**Verifying inspector changes without a rebuild.** `src/inspector/**` is baked into `cno.exe`
(esbuild→cjsc→link), so a change is invisible to anything that *spawns* the binary until it is
rebuilt — that is why the `cdp-discovery`/`cdp-debugger`/`cdp-paused-stack` tests keep failing at
an old defect after a source fix. But a test that **imports from `src/inspector/**` directly**
loads the TypeScript from disk and therefore exercises the *working tree*. `startServer`,
`ObjectStore`, `PipeClient`/`PipeServer`, `CdpChannel`/`handleDevToolsConnection` and the domains
are all reachable that way, so most of this subsystem is verifiable immediately:
`cdp-endpoint.test.ts` (HTTP/WS surface, in-process), `cdp-lifetime.test.ts` (store + pipe),
`cdp-detach.test.ts` (console/fetch detach, `isLoopbackHost`) and `cdp-protocol.test.ts`
(dispatch + connection) need no rebuild. Prefer that over a spawning test.

Two traps in that style:
- **`fetch()` is unusable in a module graph that imports `worker/server.ts`.** It pulls in a second
  copy of `cno/src/webapi/*` and the global fetch then throws `TypeError: Illegal invocation` from
  `performFetch` → `addEventListener` (its `AbortSignal` brand check fails across the two copies).
  Use raw TCP (`node:net`) — which is needed anyway for forged/duplicated `Host` headers, since the
  fetch API forbids both.
- **`tests/**` is not type-checked by any project config** (`tsconfig.json` `include` is `src/**`;
  `tsconfig.audit.json` is `cno/src/**`). This is exactly how `cdp-protocol.test.ts` kept building
  a `ConnectionDeps` without `consoleDomain`/`fetchDomain` and still passing on a contract that no
  longer existed — `detach` was the only reader and `FakeSocket` never fired `onclose`. Check test
  files explicitly with `npx tsc -p tsconfig.cdptests.json`. Node builtins need the narrow ambients
  in `tests/node/cdp-test-ambient.d.ts`: full `@types/node` is deliberately not loaded, so without
  them the output is only "cannot find name 'node:assert'" and real errors stay buried.

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

### Reading the Runner's Output — streams, counts, truncation

Three properties of the runner have each cost a wrong conclusion, and none of them
is guessable from the output alone.

**`ok` goes to stdout; `fail`, `skip` and `retry` go to stderr.** The per-test lines
use different console methods (`cno/src/deno/index.ts`): `console.info('  ok …')` at
`:834`, `console.warn('  skip …')` at `:762`, `console.error('  fail …', err)` at
`:836`, `console.warn('  retry …')` at `:811`. OBSERVED 2026-08-04 on
`build/stage/cno.exe`: `console.info`/`console.log` land on **stdout**,
`console.warn`/`console.error` on **stderr**. So **a stdout-only capture of a
failing file reports zero failures** — it sees the `ok` lines and nothing else.
Capture both streams (`2>&1`, or two files) before counting anything.

**`✔ N/M` is a *file* count, not a test count.** `src/commands/test.ts:396-402`
computes `const total = results.length` over per-file results, so `✔ 3/3` means
three files passed and says nothing about how many `Deno.test` cases ran inside
them — a file that registers zero tests still counts as a pass. To count *tests*,
count the ` ok `/` fail ` lines (from both streams), and see Probe Hygiene before
trusting a `grep -c` of `Deno.test(` in the source.

**An uncaught error truncates the rest of the file, silently.**
`cno/src/deno/index.ts:757` is `if (stopTests || suiteUncaught) break;` at the top
of the `testRegistry` loop, and `:771` repeats it for the repeat/retry loop. So the
first uncaught error — anything reaching the `'error'` listener, including
`reportError` or a stray rejection — abandons every test after it. Those tests are
not reported as skipped or failed; they never run, and the file's total drops with
no explanation. A test count that shrinks between runs is usually this, not flake:
look for the single `(uncaught error)` entry that `:873` appends.

### Test Timeouts & Failure Attribution

A test that fails must report **why**. Three harness rules, each of which has already
cost a debugging cycle by turning a real failure into an opaque `Test timed out`:

1. **Every inner deadline must be strictly smaller than the enclosing `Deno.test`
   `timeout`.** An inner poll/retry budget `>=` the outer one can never expire first,
   so the harness kills the test and the inner error message is never produced. The
   original `cdp-*.test.ts` had `TIMEOUT_MS = 15_000` inside tests declaring
   `timeout: 10000`; six tests reported opaque timeouts that were really an HTTP 403.
2. **A retry loop must fail fast on a definitive error.** Retrying only makes sense for
   "not ready yet" (connection refused). An HTTP status means the server *answered*, so
   a 4xx/5xx is final — surface it immediately. The `cdp-*` and `deno/serve` tests use a
   local `class DefinitiveError extends Error {}`: the loop rethrows it on sight and
   retries everything else. Never `catch {}` a whole retry body.
3. **Every spawned child needs `error` and `exit` handlers**, and every `worker.once`
   message wait needs an `exit` handler. Without them a bad path or an instant crash
   surfaces only as the outer timeout — the actual `ENOENT`/exit code is never printed.
   See `startTarget()` in `tests/node/cdp-discovery.test.ts` for the pattern.

**Size timeouts from measurement, not intuition.** The per-test `timeout` wraps only
`testItem.fn` (`cno/src/deno/index.ts` — `Promise.race`), so it does **not** include the
runner's own module load — a slow-to-import file still passes a small per-test timeout.
Measured on win32, cold cache (fresh `CTS_CACHE_DIR` + `cno setup`):
| child | cold time-to-ready |
|---|---|
| `cno run --allow-net <serve target>` | 710 ms |
| `cno run --inspect=…` (first HTTP response) | 1,166 ms |
| `cno run --inspect-wait=…` | 3,226 ms |

So a child-spawning test needs seconds, not minutes. `tests/deno/serve.test.ts` passes
on a **cold** cache with `timeout: 10000` with a large margin.

**The "190s to load" figure that used to sit here is stale by ~50x and was
measured before `build/stage/ext/oxc.dll` existed.** Re-measured OBSERVED
2026-08-01 with oxc present, on a genuinely cold private cache dir
(`rm -rf` + `cno setup`, then `cno test tests/deno/serve.test.ts --concurrency=1`):

| stage | cold |
|---|---|
| `cno setup` | 2.9 s |
| the test file itself (runner's own report) | **3,734 ms** |
| whole command, wall clock | **6 s** |

Result `✔ 1/1`. Without oxc the interpreted Sucrase path is what produced the old
three-figure number, so **any timing in this document that predates oxc.dll should
be re-measured before you trust it** — check `build/stage/ext/oxc.dll` exists first.
Raising a timeout to make a test pass hides bugs — a 10s budget inflated to 120s also
stops detecting a large latency regression. If a timeout seems too small, measure the
child first; if the work is genuinely fast, the bug is elsewhere.

### Probe Hygiene

Seven traps, each of which has already invalidated a conclusion:

- **`/tmp` is shared between parallel agents.** Another agent overwrote a probe
  script mid-audit, and the run silently reported *its* output under this agent's
  labels. Namespace every scratch file (`/tmp/<your-topic>/…`) and never reuse a
  bare name like `/tmp/t1.ts`.
- **`git stash push` can fail silently in a submodule.** Check the exit code — a
  redirected `>/dev/null 2>&1` hides the failure, and the follow-up conclusion
  ("my edit is gone") is then wrong in the *safe* direction only by luck. Never
  A/B your own change through the shared index at all: the repo holds other
  agents' uncommitted work. Copy the file aside instead.
- **grep for text you have verified, not text you remember writing.** Searching
  for a half-remembered comment returned no match and produced a false "the fix
  is absent" conclusion; the fix was present under different wording. Grep for a
  distinctive token you have just read on disk.
- **Do not measure formatting *through* the thing under test.** `console.log`
  applies its own `%`-formatting and (via the native console) collapses `%%` and
  drops array inner spaces, so `console.log(util.format('a%%b'))` is circular and
  reports a wrong answer while looking authoritative. Use
  `process.stdout.write(JSON.stringify(x))` for anything format-, `%`- or
  whitespace-sensitive. Related: order-sensitive fixtures must not be accidentally
  palindromic — `one,two,one` cannot distinguish newest-first from oldest-first
  history, `alpha,beta,gamma` can.
- **A `.js` file in a directory with no `package.json` is ESM, so CJS probes die
  with `module is not defined`.** Cost a cycle in the 08-02 audit: a probe wrote its
  fixture as `dep.js` containing `module.exports = …`, and the *whole script*
  aborted with `module is not defined` before printing a single line — which looks
  exactly like the feature under test being broken, not like a fixture mistake.
  Name CJS fixtures `.cjs` explicitly (or drop a `{"type":"commonjs"}`
  `package.json` in the scratch dir). Corollary: **buffered `process.stdout.write`
  output is lost when a probe throws**, so a crash can present as "the probe
  printed nothing". Use `console.log` in probes that might throw, and give each leg
  its own try/catch so one failure cannot hide the other results.
- **Confirm a measuring tool exists before believing a zero.** `strings` is **not
  installed** in this MSYS environment, so `strings cno.exe | grep -c tok` returns 0
  for every token — and with `2>/dev/null` the "command not found" is invisible. That
  produced a false OBSERVED claim in this very file (see "Which copy of `@cnojs/http`
  runs"). Search a binary with `grep -a -c tok build/stage/cno.exe`, and validate the
  harness against a token that must be present before trusting an absence.
- **A stale `CTS_CACHE_DIR` answers with OLD polyfills, and the answers look
  plausible.** The cache holds a *copy* of `cno/src/node/**` and of `@cnojs/http`
  (see "Which copy of `@cnojs/http` runs"), never a link, so a cache dir created
  before your edit — or before someone else's — serves the previous revision with
  no warning and no version skew visible anywhere in the output. This fabricated
  three findings for one agent on 2026-08-03: every measurement was real, every
  conclusion was about code that had already been replaced. Run `cno setup` against
  the exact `CTS_CACHE_DIR` you are about to test with, treat `0 ok / 0 fail` as a
  broken cache rather than a regression, and never share a cache dir with a
  concurrent agent — its `setup` can clobber yours mid-run.

**Oracles available on this box** (so you never have to reason where you could
measure): real Node is `node` (v24.18.0) and real Deno is `deno` (**2.9.3**,
`/c/Windows/deno.exe`, on PATH) — OBSERVED 2026-08-02. The Deno-compat and
Node-compat tables in this file were built differentially against exactly those two,
so a disagreement is reproducible rather than historical.

### Test Runner
`src/commands/test.ts`:
- File pattern: `[._]test.[jt]sx?`
- Parallel execution with configurable concurrency
- Skip dirs: `node_modules`, `.git`, `dist`, `build`
- Roots are **deduplicated** (`collectTests`): `cno test . a_test.ts` must not run
  `a_test.ts` twice and report `2/2`. Deno dedupes too.
- `--concurrency` rejects a non-integer/`< 1` value instead of falling back to 4;
  a silent default hides a typo in a CI config. Any `--inspect*` forces serial.
- A failing file exits 1 (`✖ passed/total`); `--permit-no-files` turns "no test
  modules found" from exit 1 into `✔ 0/0`.

### Run Tests
```bash
cno test                    # All test files
cno test src/module/        # Specific directory
cno test --concurrency=8    # Custom concurrency
cno test --filter=<substr>  # Only tests whose name matches
cno test --fail-fast        # Stop at the first failure
```

**There is no `cno` on `PATH` here** (OBSERVED 2026-08-04, `which cno` → not
found), so every bare `cno …` line in this document means `build/stage/cno` — or
`build-release/stage/cno`, which also exists and is a Release build while `build/`
is configured `Debug`. Point `CTS_CACHE_DIR` at a directory you own and run
`cno setup` into it first; a run against an unseeded cache reports `0/N`.

```bash
# Pack changes: rebuild the embedded CLI, then run the focused gates.
cmake --build build -j2
CTS_CACHE_DIR=/tmp/cno-pack-test build/stage/cno setup
CTS_CACHE_DIR=/tmp/cno-pack-test build/stage/cno test tests/cts/pack-command.test.ts --concurrency=1
CTS_CACHE_DIR=/tmp/cno-pack-test build/stage/cno test tests/cts/import-attributes-runtime.test.ts tests/cjs/require-esm-interop.test.ts --concurrency=1
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

The two lists that used to appear in this file disagreed with each other (one
included `transformer`, the other omitted it) and both were badly incomplete —
9 names against 33 real ones. `DEBUG=oxc` and `DEBUG=pack` in particular are used
elsewhere in this document but were absent from both lists. Full set, harvested
from every `log.debug(...)`/`log.warn(...)` call site in `cts/src`, `src` and
`cno/src` (OBSERVED 2026-08-01):

```
archive  bin     bridge   cjs      cleanup  cno     config   debug
deps     fetch   http     jsc      jsr      lifecycle  loader lock
node     npm     oxc      pack     pkg      precache  precompile
resolver resources  run   runtime  scan     setup   source   task
transformer  wasm
```

Plus `http.conn`, which lives in `http/src` and is emitted via `dbg()` rather
than `log.debug()`, and `stack`, which is not a `log.debug` category at all — it
is matched separately in `cts/src/errors.ts:286` (`str === '*' || str.includes('stack')`)
to control error-stack output.

Syntax (`cts/src/utils/log.ts`): comma-separated, whitespace-trimmed; `*` enables
everything; a leading `!` **disables** one category, so `DEBUG=*,!resolver` is the
useful "everything except the noisy one" form. That negation is not obvious from
the code and was previously undocumented.

Note `log.warn` does **not** consult the filter — it prints regardless of `DEBUG`,
so a `log.warn` category is not silenceable this way.

The most commonly useful ones:
- `resolver` — Module resolution
- `npm` / `jsr` — registry package handling
- `lock` — Lock file operations
- `cjs` / `bridge` — CommonJS interop and the CJS↔ESM bridge
- `loader` / `source` — Module loading and source reads
- `config` — Config loading
- `transformer` / `oxc` — TS transform and the native OXC path
- `jsc` / `precompile` / `precache` — bytecode cache and worker precompile
- `pack` — `.jspack` container build/load
- `stack` — Stack trace handling (special-cased, see above)

### Dev Mode Run — the documented command does not work as written

```bash
# As previously documented (does NOT work in this checkout):
cts src/main.ts run script.ts
```

Three separate problems, all OBSERVED 2026-08-01:

1. **There is no `cts` executable.** `which cts` → not found; the root
   `package.json` has no `bin`; there is no `node_modules/.bin/cts`. The command is
   copied from the root `"dev": "cts src/main.ts"` script, which is equally
   unrunnable here. (`src/main.ts` in that script is the **root** cno-cli entry, not
   `cts/src/main.ts` — that path does not exist. cts's own entry is `cts/main.ts`.)
2. **`cno run src/main.ts` — the obvious substitute — fails on decorators.** It dies
   with `Syntax error in cno/src/deno/03_fopen.ts:162: invalid property name` on a
   `@wrap` decorator, **with `oxc.dll` loaded** (`DEBUG=oxc` confirms
   `[oxc] loaded cjs-ext-oxc 0.1.0 (oxc)` in the same configuration). There are
   **59 decorator sites across 6 files** — `deno/03_fopen.ts`, `deno/05_net.ts`,
   `deno/06_process.ts`, `deno/07_http.ts`, `deno/08_serve.ts`, `utils/stdio.ts`.
   So the decorator gap documented under ext-oxc is not academic: **the polyfill
   layer cannot be run from source at all** until oxc's decorator transform is
   enabled. Only the esbuild bundle path (`dist/cno-cli.js` → baked into `cno.exe`)
   handles them, which is why the shipped binary works and running the tree does not.
3. **`cno run cts/main.ts` fails too**, for an unrelated reason worth reporting as a
   code bug rather than working around: `cts/main.ts:13` does
   `import { version } from './package.json'`, and that named JSON import is not
   resolved — `Could not find export 'version' in module '…/cts/package.json'` — even
   though `cts/package.json` does have `"version": "3.3.1"`. (Node does not allow
   named exports from JSON modules either, so this line is questionable regardless.)

Practical consequence: **there is currently no working "run it from source" mode for
the polyfill layer.** Verify TS changes either through `cno setup` (for
`cno/src/node/**`, which is copied to the cache rather than transpiled by oxc) or by
importing the specific module directly from a test, per "Verifying inspector changes
without a rebuild" above. Do not add a `cts`-based recipe back to this file without
checking that it runs.

### Bytecode Cache

- Local modules: `~/.cts/local/<hash-prefix>/<hash>.jsc` with an mtime sidecar
- Remote modules: `.jsc` and `.jsc.mt` beside cache-owned sources; workspace/symlink targets use the hashed local cache so source trees stay untouched
- Packed modules: one mapped buffer + lazy 0-copy views; on-demand deserialize; `sourceOnly` skips bytecode
- Version mismatch auto-clears
- **Shape mismatch is not corruption.** A file loaded both as an `engine.Module`
  and as a raw compiled value (`EVAL_COMPILE_ONLY`) shares one cache identity, so
  `load()` / `loadCompiled()` verify the deserialized shape. A mismatch is a plain
  cache **miss** — return null and leave the `.jsc` alone. Only a failed
  *deserialize* (real corruption / ABI skew) may purge. Purging on shape mismatch
  makes a dual-loaded file recompile on every single load, forever.
- **Freshness stamps describe the source revision that compilation started
  from.** `JscCache.captureFreshness()` records `mtime:size` before the source
  read; on-demand ESM, CJS wrappers, and worker precache thread that snapshot
  into the bytecode write. If the source changes during compilation, the next
  lookup sees a mismatch and recompiles instead of permanently blessing old
  bytecode with the new source's stat. A failed pre-read stat fails closed: the
  module may execute, but that compile is not persisted. This is not lock
  verification — authoritative resolver rows remain trusted.
- Corrupt/partial `.jsc` recovery is sound (verified): truncated, zero-length,
  random-garbage, and missing-`.mt` all fall back to recompile and self-heal.
- The stamp is `String(stat.mtim)` — a **second**-resolution, timezone-formatted
  date string. The C layer's `mtim` carries no sub-second precision
  (`Number(mtim)` ends in `000`), so a same-second *and* same-size edit is
  invisible. `Number(stat.mtim)` would be equivalent in resolution but immune to
  an OS timezone change silently invalidating every entry.
- Cache roots are canonical filesystem paths. `createConfig` normalizes separator,
  duplicate-slash, dot-segment, and trailing-slash variants, and `JscCache` repeats
  that normalization for direct consumers. Remote bytecode therefore remains
  adjacent for cache roots supplied as `C:/cache//` instead of falling into the
  hashed local cache. `normalizePath` leaves protocol specifiers (`https://`,
  `node:`, `npm:`) untouched; their repeated slashes are not filesystem noise.

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
- Worker-parallel OXC (native) / Sucrase (fallback) import scan and transform
- Workers return SharedArrayBuffer-backed code and source-map bytes; transform results carry only the task id plus payload.
- The main thread must register source maps, then call `new engine.Module(...).dump()`; QuickJS dependency resolution is runtime-local, so neither step may move to a worker.
- Each worker has at most two ordered transform tasks in flight, overlapping OXC work with the serialized QJS/disk lane without unbounded result buffering.
- Plain `.js`/`.mjs`/`.cjs` modules compile directly from bytes on the main thread; malformed legacy encodings fall back to the string path.
- Default workers reserve one core for main-thread QJS compile: inline on low/one-core, up to two on normal, cores minus one on high; `CTS_WORKERS` overrides this.
- Scan tasks have no wall-clock kill; worker/IPC failures restart the worker and retry the task without main-thread fallback or per-file blame.
- Transform tasks retain a 60s safety timeout; exhausted infrastructure retries fail the worker batch, not an arbitrary source file.
- BFS `wake()` in `deps.ts` only fires on `enqueue` or `pending===0`, not on every `finally` — otherwise idle workers busy-loop

### Networking
- HTTP/2 multiplexing via native extension
- DNS caching with TTL
- SSL session reuse

---

## Author

iz (imzlh)

## License

MIT
