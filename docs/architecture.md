# Architecture

`cno-cli` is an integrated runtime built from several layers in this checkout.
The final user-facing binary is `cno`.

```text
user command
  -> src/main.ts
  -> src/commands/*
  -> cts TypeScriptRuntime
  -> cno Web/Deno/Node/CNO polyfills
  -> circu.js native runtime
  -> QuickJS + libuv
```

## Layers

| Layer | Directory | Responsibility |
| --- | --- | --- |
| CLI | `src/` | Argument parsing, command dispatch, inspector setup, test/task/cache/setup |
| Loader | `cts/` | Module resolution, source transform, module compile, lock/cache |
| Polyfills | `cno/` | Web API, Deno API, Node builtins, CNO namespace |
| Protocol helpers | `http/` | Raw HTTP/TCP/TLS helpers used by higher layers |
| Native core | `circu.js/` | QuickJS runtime, libuv loop, native modules, bytecode compiler |
| Native extensions | `ext-oxc/`, `ext-quic/`, `http/ext-h2/` | Optional runtime capabilities |

## Normal Run Path

`cno run app.ts` and implicit `cno app.ts` follow this path:

```text
src/main.ts
  dispatch()
  runEntry()

src/commands/run.ts
  parse inspector flags
  attach inspector if requested
  load config files
  createRuntime()
  load entry module
  eval module

cts/src/runtime/index.ts
  create resolver
  create compiler
  try load OXC
  install engine hooks

cts/src/resolve/index.ts
  resolve entry and imports to ModuleInfo

cts/src/compile/index.ts
  load ESM/CJS/WASM/JSON/text/binary
```

## Bootstrap Order

`src/main.ts` imports `../cno/src/main` before dispatching user commands.
`cno/src/main.ts` installs polyfills in this order:

```text
cno/src/webapi/index.ts
cno/src/deno/index.ts
cno/src/cno/index.ts
cno/src/node/_internal/inject.ts
```

That means Web API and Deno globals exist before user code runs. Node globals
such as `process` and `Buffer` are lazy getters backed by the runtime
`require()` bridge.

## Package Boundaries

`cts/` must not become a Web/Deno/Node compatibility layer. It can know how to
resolve `node:` builtins, but the implementation of those builtins lives in
`cno/src/node`.

`cno/` should implement compatibility APIs in TypeScript and call native
modules through `import.meta.use()`.

`http/` should stay a raw protocol helper package. It should not expose Web API
objects such as `Request`, `Response`, `Headers`, or `URL` as core concepts.

`circu.js/` owns QuickJS, libuv, and native module behavior. When a native
module API changes, update `circu.js/types/` too.

## Single Runtime Hook Constraint

The native engine exposes replacement-style hooks for module loading, events,
and promises. A process should treat `TypeScriptRuntime` as the owner of those
hooks. Creating another runtime in the same process replaces the previous hook
set and can invalidate assumptions in loaded modules.

Workers have independent JS contexts, so the hook replacement concern is
per-process or per-worker context, not global across all workers.

## Command Categories

| Category | Commands |
| --- | --- |
| Execute code | `run`, implicit run, `eval`, `repl` |
| Project tooling | `task`, `exec` |
| Cache/setup | `cache`, `setup` |
| Validation | `test` |
| Diagnostics | `--inspect`, `--inspect-brk`, `--inspect-wait`, `DEBUG=*` |

## Data Stores

| Store | Default location | Owner |
| --- | --- | --- |
| CTS cache | `~/.cts` or `CTS_CACHE_DIR` | `cts/src/config.ts` |
| Bytecode cache | inside CTS cache | `cts/src/source/cache.ts` |
| npm package cache | `<cacheDir>/npm/<name>@<version>` | `cts/src/resolve/protocols/npm.ts` |
| Node polyfills | `<cacheDir>/node` | `src/commands/setup.ts` |
| Resolution lock | project root or cache dir | `cts/src/runtime/index.ts`, `cts/src/lock.ts` |

`cno cache` is the command that persists `cts.lock`. Normal runtime commands
use read-only or in-memory lock stores.
