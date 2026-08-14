# AGENT.md - cno-cli Project Guide for AI Agents

This file is the compact maintainer context for this repository. It describes
the architecture, ownership boundaries, important invariants, and normal
validation workflow. Detailed compatibility results and historical debugging
notes belong in `docs/` or regression tests.

## Project Overview

`cno-cli` is a Deno-compatible TypeScript runtime with a growing Node.js
compatibility layer. The user-facing product is the native `cno` binary, built
from several projects in this checkout.

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


| Directory | Responsibility |
| --- | --- |
| `src/` | CLI parsing, command dispatch, inspector, setup/cache/test/task workflows |
| `cts/` | TypeScript runtime, module resolution, transformation, compilation, cache and lock handling |
| `cno/` | Web API, Deno API, Node builtin and CNO-specific polyfills |
| `circu.js/` | QuickJS/libuv host, native modules, workers, bytecode compiler and C APIs |
| `http/` | `@cnojs/http`, low-level HTTP/TCP/TLS protocol helpers |
| `ext-oxc/` | Optional native OXC transform and import scanner |
| `ext-quic/` | Optional QUIC support |
| `tests/` | Compatibility and runtime regression tests |
| `scripts/` | Bundling, packaging and development helpers |
| `docs/` | Maintainer documentation for specific subsystems |

The normal execution path is:

```text
src/main.ts
  -> src/commands/run.ts
  -> cts/src/runtime/index.ts
  -> cts/src/resolve/       specifier -> ModuleInfo
  -> cts/src/source/        read + scan + transform
  -> cts/src/compile/       ESM/CJS/JSON/WASM/etc.
  -> cno polyfills
  -> circu.js native runtime
```

`src/main.ts` bootstraps `cno/src/main.ts` before dispatching user code. The
polyfill bootstrap installs Web APIs, Deno APIs, CNO APIs, and Node globals in
that order. `process` and `Buffer` are lazy global getters backed by the Node
bridge.

## Working Rules

### Native Modules And Imports

- Use `import.meta.use('module')` for circu.js native modules. It is a runtime
  primitive, not a normal JavaScript import.
- Avoid unnecessary type casts around native module values. Read the matching
  declaration in `circu.js/types/` first and narrow values properly.
- `os.getenv()` throws when a variable is absent; catch that case when absence
  is expected.
- For straightforward UTF-8 work, prefer `engine.encodeString`/
  `engine.decodeString` when their semantics are sufficient.
- Avoid adding global state when a native module or an explicitly owned runtime
  object can carry the state.

### Ownership Boundaries

- `cts/` owns module loading mechanics. It must not become a Web, Deno, or Node
  compatibility implementation.
- Node builtin implementations live under `cno/src/node/`. Node modules should
  not reach into unrelated `cno` layers; shared native functionality should be
  obtained through `import.meta.use()`.
- Web API objects such as `Request`, `Response`, `Headers`, and `URL` belong in
  `cno/`, not in the low-level `http/` protocol package.
- `circu.js/` owns QuickJS, libuv, native module behavior, and native resource
  lifetimes. When a native API changes, update `circu.js/types/` too.
- `TypeScriptRuntime` owns engine module/event/promise hooks for its JS context.
  Creating another runtime in the same context replaces those hooks.

### Module Semantics

- Never infer ESM or CJS from source contents. Use file extensions, package
  metadata/conditions, or an explicit caller format.
- Preserve canonical module identity. `specPath` is the resolver identity;
  `localPath` is the readable source/cache path and is not always derivable
  from it.
- Keep CJS/ESM bridge behavior compatible with the existing rules in
  `cts/src/compile/bridge.ts`. In particular, synchronous `require()` of an
  unresolved top-level-await ESM module must fail rather than return a partial
  namespace.
- Treat lock data as authoritative resolved state. Do not add ad-hoc source
  verification to compensate for a lock entry unless the owning contract is
  deliberately changing.

### Editing Style

Prefer a focused patch over a broad rewrite. Match surrounding code and keep
comments short; comments should explain a non-obvious invariant, not restate
the code.

```ts
import type { SomeType } from './types.ts';

const fs = import.meta.use('fs');

const read = (path: string) => fs.readFile(path);
```

Use existing helpers and local abstractions before adding new ones. Preserve
error shapes and cleanup paths. Generated binaries, caches, lock changes, and
unrelated worktree edits should not be included in a focused source change.

## circu.js: Native Runtime

**Location:** `circu.js/`
**Language:** C plus TypeScript declarations
**Role:** QuickJS engine, libuv event loop, native I/O and runtime services.

circu.js provides the host APIs consumed through `import.meta.use()`. The
main groups are:

| Group | Native modules |
| --- | --- |
| Runtime | `engine`, `os`, `process`, `worker`, `timers`, `signals` |
| Files and data | `fs`, `asyncfs`, `fswatch`, `streams`, `sqlite3`, `xml`, `jsonc`, `bjson` |
| Network | `http`, `curl`, `dns`, `ssl`, `udp`, `socket`, `debug` |
| Encoding and crypto | `text`, `crypto`, `zlib`, `brotli`, `algorithm` |
| Integration | `ffi`, `nodeapi`, `win32`, `sourcemap`, `wasm`, `console` |

Important files:

```text
circu.js/src/modules.c       native module registration
circu.js/src/mod_*.c         individual native modules
circu.js/src/worker*.c        worker and message-pipe behavior
circu.js/src/mod_engine.c     engine hooks and module integration
circu.js/types/*.d.ts         TypeScript declarations
circu.js/CMakeLists.txt       native build targets
```

The native build produces the runtime executable (`cjs`/`cno` integration),
the bytecode compiler (`cjsc`), and libraries used by extensions. Native code
is higher risk than TypeScript code: check callback ownership, C argument
counts, JS value lifetimes, worker teardown, and allocator pairing.

### Native Safety Rules

- A `JS_CFUNC*_DEF` callback must never read an argument beyond its declared
  `length`; validate `argc` before indexing `argv`.
- Do not retain raw pointers returned from JS buffers across calls that can
  invoke user code or trigger ArrayBuffer detachment. Copy or finish the native
  operation before such calls.
- Property access, conversion, calls, iteration, and user callbacks can run JS
  and invalidate native assumptions. Capture stable values before re-entry.
- One-time shared initialization belongs behind `uv_once`; mutable per-thread
  state must not be a plain process-global without synchronization.
- Make `uv_close`/finalizer paths idempotent and keep explicit worker
  exited/joined state. A null runtime pointer alone does not prove teardown is
  complete.
- Match every native allocation and free to the allocator that owns it. Do not
  mix QuickJS/circu.js, system, mimalloc, and extension allocators casually.
- Parser loops handling untrusted input must always advance or terminate on
  malformed input; a `break` that leaves the cursor unchanged can spin forever.
- Preserve host symbols needed by Node N-API addons while keeping `Deno.dlopen`
  libraries isolated where the platform loader requires it.

## cts: TypeScript Loader

**Location:** `cts/`
**Role:** Resolve specifiers, read and transform source, compile modules, and
manage caches, locks, package materialization, tasks, and packed modules.

The loader is organized as a pipeline:

```text
caller / engine hooks
        |
runtime/       lifecycle, hooks, import.meta, resources
        |
resolve/       protocol dispatch and package resolution
        |
source/        source reads, import scan, OXC/Sucrase transform, bytecode cache
        |
compile/       ESM, CJS, WASM, JSON/text/binary, interop bridge
```

### Key Files And Directories

| Path | Responsibility |
| --- | --- |
| `cts/src/runtime/index.ts` | `TypeScriptRuntime`, composition root and cleanup |
| `cts/src/runtime/hooks.ts` | `engine.onModule` resolve/load/init/attribute hooks |
| `cts/src/runtime/meta.ts` | `import.meta` fields and `import.meta.resolve()` |
| `cts/src/runtime/resources.ts` | Per-runtime resource ownership and release |
| `cts/src/resolve/index.ts` | Resolver facade and resolution caches |
| `cts/src/resolve/protocols/` | `file`, `npm`, `jsr`, HTTP, Node, data and pack handlers |
| `cts/src/resolve/pkg.ts` | package `exports`, `imports`, and legacy entry resolution |
| `cts/src/resolve/linker.ts` | npm package materialization for `--npm-mode` |
| `cts/src/source/transform.ts` | OXC/Sucrase transform and diagnostics boundary |
| `cts/src/source/cache.ts` | In-memory/disk bytecode cache |
| `cts/src/compile/index.ts` | compiler facade and dispatch by `ModuleInfo` |
| `cts/src/compile/esm.ts` | ESM and non-CJS module compilation |
| `cts/src/compile/cjs.ts` | CJS execution, `require`, and CJS cache |
| `cts/src/compile/bridge.ts` | CJS/ESM bridge and synchronous ESM loading |
| `cts/src/compile/wasm.ts` | WASM modules and import handling |
| `cts/src/lock.ts` | SQLite resolution state |
| `cts/src/deps.ts`, `parse.ts` | dependency scan and worker-backed precache |
| `cts/src/pack/` | `.jspack` writing, validation, and lazy loading |
| `cts/src/config.ts` | CLI/environment/project configuration |

The central type is `ModuleInfo`:

```ts
type ModuleFormat = 'esm' | 'cjs';
type FileKind = 'source' | 'json' | 'wasm' | 'binary' | 'text';

interface ModuleInfo {
  specPath: string;  // canonical module identity
  localPath: string; // source or cache path
  format: ModuleFormat;
  fileKind: FileKind;
}
```

### Resolution

The resolver uses protocol handlers for:

| Specifier | Handler |
| --- | --- |
| relative/absolute paths and `file:` | `resolve/protocols/file.ts` |
| `npm:` and bare npm packages | `resolve/protocols/npm.ts` |
| `jsr:` and JSR aliases | `resolve/protocols/jsr.ts` |
| `http:` and `https:` | `resolve/protocols/http.ts` |
| `node:` and builtin aliases | `resolve/protocols/node.ts` |
| `data:` | `resolve/protocols/data.ts` |
| `pack:` | `resolve/protocols/pack.ts`, only in a pack session |

Resolution has three conceptual stages:

```text
source key -> canonical specPath -> ModuleInfo
```

The lock store and in-memory caches accelerate these stages. Package resolution
must honor package `exports`/`imports`, conditions, file kinds, URL decoding,
and CJS directory lookup order. Do not fix one protocol by bypassing the
canonical identity or by treating an unresolved package as a local file.

### Transform And Compile

Source handling is format-agnostic until the compiler receives `ModuleInfo`.
OXC is the preferred native transform/import scanner when enabled; Sucrase is
the fallback. Diagnostics should retain source location and become the normal
CTS transform error type rather than an opaque native exception.

Compiler dispatch is:

```text
WASM             -> WasmCompiler
CJS source       -> CjsLoader -> CJS/ESM bridge
ESM source      \
JSON/text/binary  -> EsmCompiler
```

Keep module registration and circular dependency behavior intact. CJS and ESM
may observe live or partially initialized exports according to the existing
bridge contract; do not replace that behavior with a generic object copy.

### Cache, Lock, And Precache

The CTS cache contains downloaded sources, Node polyfills, and bytecode. The
lock is SQLite-backed resolution state, not a complete package manager lockfile.

| Operation | Lock behavior |
| --- | --- |
| `cno cache` | scans dependencies and persists `cts.lock` |
| `run`, `eval`, `repl`, `test` | read existing lock or use read-only/in-memory state |
| `--no-lock` | memory-only resolution |
| `--frozen` | reject resolution not already represented in lock state |

Precache roughly does:

```text
scan graph -> resolve/download -> optional node_modules materialization
           -> optional lifecycle scripts -> worker transforms -> cleanup
```

Resource cleanup must run on both success and failure. Parse workers must be
terminated and runtime-owned resources released exactly once.

npm packages use a flat cache such as:

```text
<cacheDir>/npm/<name>@<version>/
```

`--npm-mode` controls project materialization during cache workflows:

| Mode | Behavior |
| --- | --- |
| `normal` | keep the flat CTS cache; do not create a project tree |
| `soft` | create links/junctions from the project into the store |
| `hard` | create a hard-linked project virtual store, with copy fallback |

The store should remain cache-owned. Materialization should use the resolved
dependency graph rather than guessing versions again from semver text.

### Packed Modules

`cts/src/pack/` writes a complete resolved graph to `.jspack`. Pack identities
are `pack:` identities and must not escape to the original source tree for a
missing edge. Source bytes are retained with compiled data so a pack can
recover from bytecode ABI changes or source-sensitive loading. Loading maps the
container once and uses lazy views/deserialization; it should not extract every
module to disk.

## cno: Compatibility Layer

**Location:** `cno/`
**Role:** Install the APIs users expect from Web, Deno, Node, and CNO.

Bootstrap order in `cno/src/main.ts`:

```text
cno/src/webapi/index.ts
  -> cno/src/deno/index.ts
  -> cno/src/cno/index.ts
  -> cno/src/node/_internal/inject.ts
```

### Directory Map

| Path | Surface |
| --- | --- |
| `cno/src/webapi/` | events, URL, text, blobs, streams, fetch, WebSocket, crypto, performance, WebAssembly |
| `cno/src/webapi/fetch/` | Web fetch/request/response/header implementation |
| `cno/src/deno/` | Deno permissions, filesystem, stdio, network, process, HTTP, serve, FFI, KV, QUIC |
| `cno/src/node/<name>/` | Node builtin modules such as `fs`, `net`, `http`, `crypto`, `stream`, `vm`, `wasi`, `zlib` |
| `cno/src/node/_internal/` | shared Node internals, errors, buffers, HTTP helpers, clone and network utilities |
| `cno/src/cno/` | runtime-specific engine, PTY, SSL, compression and llhttp helpers |
| `cno/src/type/` | runtime and compatibility declarations |

Most Node modules follow this shape:

```text
cno/src/node/<name>/mod.ts    exports and native-facing module object
cno/src/node/<name>/index.ts  public polyfill entry
```

Node modules must stay within the Node layer unless a shared boundary is
intentional and documented. Use shared internal helpers when several Node
modules need identical semantics, but do not duplicate native resource logic.

`cno setup` copies/refreshes `cno/src/node/` into the cache used by the staged
binary. This is why a Node-only edit can usually be tested with `setup`, while
Web API, Deno, bootstrap, and CLI edits normally require a rebuild.

## HTTP And Protocol Layer

`http/` is `@cnojs/http`, a low-level protocol library used by the compatibility
layer. It owns HTTP/1 parsing, HTTP/2 integration where enabled, TCP/TLS socket
helpers, request/response framing, and protocol-specific errors.

Keep these boundaries clear:

- raw protocol and transport state belongs in `http/`;
- Web `Request`/`Response`/`Headers` and fetch semantics belong in `cno/`;
- Node `http`, `https`, `net`, `tls`, and server compatibility belongs under
  `cno/src/node/`;
- native HTTP parser/TLS/socket primitives belong in `circu.js/`.

Changes crossing these layers need tests at the public surface, not only a
unit test of the lowest helper. Be careful with stream backpressure, request
body ownership, header limits, TLS write serialization, and close/error event
ordering.

## CLI

`src/main.ts` is the entry point. It bootstraps polyfills, parses arguments,
registers extensions, dispatches commands, and installs process cleanup.

| Command | Owner | Purpose |
| --- | --- | --- |
| `run <file>` | `src/commands/run.ts` | create CTS runtime and execute entry |
| `serve <file>` | `src/commands/serve.ts` | load the default `{ fetch, onListen? }` export and own the HTTP listener |
| implicit `<file>` | `src/main.ts` + `run.ts` | shorthand for `run` |
| `eval <code>` | `src/commands/eval.ts` | evaluate source |
| `repl` | `src/commands/repl/` | interactive evaluation |
| `test [paths]` | `src/commands/test.ts` | child-process test runner |
| `task [name]` | `src/commands/task.ts` | Deno/package task execution |
| `cache [file]` | `src/commands/cache.ts` | dependency scan and lock persistence |
| `pack <file>` | `src/commands/pack.ts` | create `.jspack` container |
| `setup` | `src/commands/setup.ts` | install Node polyfills into cache |
| `exec <bin>` | `src/commands/bin.ts` | resolve and spawn package binaries |

The first non-flag token determines command versus implicit run. Once the
script entry is found, remaining tokens are script arguments and must not be
reinterpreted as cno flags. The parser also reconstructs runtime argv so
`Deno.args` and `process.argv` work consistently across commands.

Common option families:

```text
--cache-dir=<dir>       --lock-dir=<dir>       --no-lock       --frozen
--reload                --precache            --disable-cache
--no-http               --no-jsr              --no-node
--no-oxc                --ignore-scripts      --npm-mode=normal|soft|hard
--silent                --inspect[=host:port]
--inspect-brk[=host:port]                       --inspect-wait[=host:port]
```

Keep help text and parser behavior synchronized with `src/help.ts`,
`src/cli.ts`, and the owning command. Deno permission and unstable flags are
accepted as compatibility no-ops where the parser recognizes them.

### Inspector

The CDP inspector is split across `src/inspector/`:

```text
DevTools
  <-> worker WebSocket server and CDP dispatcher
  <-> transport/RPC
  <-> main inspector state and object store
  <-> native debug hooks
```

| Directory | Responsibility |
| --- | --- |
| `src/inspector/main/` | execution state, object store, pause controller, RPC handlers |
| `src/inspector/worker/` | WebSocket server, discovery endpoints, CDP dispatch |
| `src/inspector/transport/` | main/worker message channels |
| `src/inspector/domains/` | Debugger, Runtime, Console, Network, Fetch, Page, Target |
| `src/inspector/shared/` | protocol types and RPC contracts |

Inspector attachment must happen before `createRuntime()` so the inspector
can wrap module lifecycle hooks before CTS installs its engine hook. Changes to
pause/resume behavior must consider remote object lifetime and release of
paused-scope objects. Changes to discovery must test `/json` metadata and
WebSocket URL behavior separately from protocol attach.

## Build System

### Dependencies

The normal JavaScript dependency setup is:

```sh
pnpm install
```

The native build requires CMake, a C compiler, and a usable `cjsc` build path.
OXC additionally needs a Rust toolchain. QUIC/HTTP2 options may need OpenSSL,
nghttp2, or the relevant submodule.

### Normal Build

```sh
cmake -B build -DCMAKE_BUILD_TYPE=Release
cmake --build build
```

The staged output is `build/stage/cno` or `build/stage/cno.exe`. The root
`CMakeLists.txt` builds circu.js, bundles the TypeScript runtime through
`scripts/bundle.mjs`, converts the bundle to bytecode, and links the final
binary.

For this checkout, `build.ps1` and `build.sh` build the main binary, attempt to
build optional OXC, and collect output under `dist/exe/`. Optional extension
failure should leave the default runtime usable through the transform fallback.

Useful CMake options include:

```text
-DCNO_BUNDLE_MINIFY=ON
-DCNO_EMBED_EXT_H2=ON
-DCNO_EMBED_EXT_QUIC=ON
-DCJSC_PATH=<path>
-DCNO_EXT_DIR=<path>
```

Do not assume a TypeScript source edit is visible in an already-built binary.
Use the layer table below:

| Changed area | Usual validation update |
| --- | --- |
| `cno/src/node/` only, excluding bootstrap internals | run `build/stage/cno setup` |
| `src/`, `cts/`, Web API, Deno API, CNO bootstrap | rebuild staged binary |
| `circu.js/` native code or declarations | rebuild; run native and affected API tests |
| `http/` | rebuild/bundle as required; run HTTP and affected compatibility tests |
| `ext-oxc/`, `ext-quic/`, HTTP2 extension | build the extension and validate the enabled path |

## Testing

The cno runner discovers `[._]test.[jt]sx?` files, skips generated/vendor
directories, and runs each test file in a child process. This is intentional:
process, signal, worker, and exit behavior should be exercised in a real child.

Focused buckets:

```sh
build/stage/cno test tests/cjs
build/stage/cno test tests/cts
build/stage/cno test tests/deno
build/stage/cno test tests/node
build/stage/cno test tests/webapi
```

General rules:

- Run the smallest bucket covering the changed contract, then broaden for
  shared runtime, loader, native, or HTTP changes.
- A test file count is not the same as the number of individual test cases;
  inspect per-test output when diagnosing counts.
- Child processes and workers need explicit `error` and `exit` handling so
  spawn failures do not become opaque outer timeouts.
- Inner polling/retry deadlines must be smaller than the enclosing test
  timeout. Retry transient readiness errors, not definitive HTTP or process
  failures.
- Use distinctive temporary paths per investigation. Do not share a cache
  directory between concurrent runs.
- Differential behavior should be compared against the available Node/Deno
  oracle when the compatibility contract is unclear, then captured as a
  regression test.

Before finishing a change, normally run:

```sh
pnpm run type-check
build/stage/cno test <focused paths>
```

Run `setup` or rebuild first when the changed layer requires it. For native
changes, also run the narrowest relevant C/runtime test and inspect stderr for
teardown or loader errors.

## Debugging And Caches

Enable focused logs with comma-separated categories:

```sh
DEBUG=resolver,npm,jsr build/stage/cno run app.ts
DEBUG=loader,source,transformer,oxc build/stage/cno run app.ts
DEBUG=precache,deps,lock build/stage/cno cache
DEBUG=* build/stage/cno run app.ts
```

Useful categories include `resolver`, `pkg`, `npm`, `jsr`, `lock`, `loader`,
`source`, `transformer`, `oxc`, `cjs`, `bridge`, `precache`, `deps`, `pack`,
`runtime`, `setup`, `task`, and `http`. Keep new logs sparse in hot paths.

The main cache locations are:

| Store | Typical owner/location |
| --- | --- |
| CTS source/package cache | `CTS_CACHE_DIR` or the user `.cts` directory |
| bytecode cache | inside the CTS cache, with source freshness metadata |
| npm packages | `<cacheDir>/npm/<name>@<version>/` |
| Node polyfills | `<cacheDir>/node/` |
| resolution lock | project root or configured lock directory |
| packed modules | mapped `.jspack` container with lazy module views |

Use a private `CTS_CACHE_DIR` for cache-sensitive work. A stale cache contains
copies of polyfills and package sources and can make a correct source edit look
ineffective. Refresh with `cno setup` or `cno cache` as appropriate before
interpreting results.

Bytecode cache misses are normal when module shape, source freshness, or the
requested load mode differs. Only actual deserialize corruption should trigger
destructive cache recovery; a shape mismatch is a miss, not proof that the file
is corrupt.

On a syntax error, inspect the corresponding failure log under the CTS cache
(`fail-<hash>.log`) in addition to the terminal diagnostic.

## Adding Or Changing Features

### Native Builtin

1. Add `circu.js/src/mod_<name>.c` and its initialization function.
2. Register the module in `circu.js/src/modules.c`.
3. Add/update declarations in `circu.js/types/`.
4. Add a focused runtime test and rebuild.

### Web or Deno API

1. Implement in the owning `cno/src/webapi/` or `cno/src/deno/` area.
2. Wire bootstrap/index exports if the API is new.
3. Keep protocol/native helpers in their owning lower layer.
4. Add a test for observable behavior and relevant error/cleanup paths.

### Node Builtin

1. Add/update `cno/src/node/<name>/mod.ts` and `index.ts` as appropriate.
2. Register the name in `cts/src/resolve/builtins.ts` when needed.
3. Keep implementation dependencies inside `cno/src/node/` or use a native
   module through `import.meta.use()`.
4. Run `cno setup` before testing the staged binary.

### Loader Protocol

1. Add a `ProtocolHandler` under `cts/src/resolve/protocols/`.
2. Register it in the resolver and define canonical identity behavior.
3. Cover resolution, cache/lock interaction, errors, and compiler dispatch.

### Inspector

Update the relevant domain plus shared protocol/RPC types, main state, worker
transport, and focused CDP tests as one contract. Check object lifetime on
pause/resume and discovery behavior when changing debugger setup.

### Native Extension

Follow the extension README, CMake registration, and staged loading path. Keep
the default build working when an optional extension is absent. Test both the
enabled path and the fallback when the feature has one.

## Documentation Map

Use these documents for details rather than expanding this file with every
compatibility finding:

- `docs/architecture.md` - runtime layers, bootstrap, and execution flow
- `docs/module-loading.md` - resolver, compiler, cache, lock, and pack behavior
- `docs/polyfills.md` - Web, Deno, Node, and CNO compatibility surfaces
- `docs/cli.md` - command routing and flags
- `docs/build-test.md` - build and validation recipes
- `docs/inspector.md` - CDP inspector architecture
- `docs/native-extensions.md` - extension model and options
- `docs/api-surfaces.md` - public and semi-public API boundaries
- `readme.md` - contributor overview

When this guide and current code disagree, verify behavior in code and tests,
then update the detailed document or this summary at the appropriate level.
