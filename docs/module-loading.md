# Module Loading

CTS is the loader used by `cno-cli`. It turns a user specifier into executable
QuickJS modules and supports TypeScript, npm, JSR, remote modules, Node builtin
polyfills, CommonJS, ESM, JSON, text, binary, and WASM.

## Main Objects

| Object | File | Responsibility |
| --- | --- | --- |
| `TypeScriptRuntime` | `../cts/src/runtime/index.ts` | Composition root |
| `ModuleResolver` | `../cts/src/resolve/index.ts` | Specifier to `ModuleInfo` |
| `ModuleCompiler` | `../cts/src/compile/index.ts` | ESM/CJS/WASM loading facade |
| `EsmCompiler` | `../cts/src/compile/esm.ts` | ESM, JSON, text, binary, bytecode cache |
| `CjsLoader` | `../cts/src/compile/cjs.ts` | CommonJS execution and require cache |
| `DepScanner` | `../cts/src/deps.ts` | Precache dependency graph scan |
| `ParseDriver` | `../cts/src/parse.ts` | Worker-backed scan and precompile |

## ModuleInfo

Resolution produces a `ModuleInfo` record:

```ts
interface ModuleInfo {
    specPath: string;
    localPath: string;
    format: 'esm' | 'cjs';
    fileKind: 'source' | 'json' | 'wasm' | 'binary' | 'text';
}
```

`specPath` is the canonical module identity. `localPath` is the readable local
file or cache path.

## Resolver Protocols

Handlers live under `cts/src/resolve/protocols/`.

| Protocol | Handler |
| --- | --- |
| local file paths and `file:` | `file.ts` |
| `npm:` and bare npm packages | `npm.ts` |
| `jsr:` and `@std/*` | `jsr.ts` |
| `http:` and `https:` | `http.ts` |
| `node:` and builtin aliases | `node.ts` |
| `data:` | `data.ts` |

Bare specifiers first check builtin aliases and path aliases, then fall through
to npm resolution.

## Resolution Cache

`ModuleResolver` uses three layers:

```text
L1 source index:
  mode + spec + parent + attrs -> specPath

L2 module index:
  specPath -> ModuleInfo

L3 protocol dispatch:
  handler resolves/downloads/reads package metadata
```

The in-process resolver also has LRU caches for repeated hot-path lookups and
stat results.

## Lock Store

`cts.lock` is a SQLite-backed resolution cache. It is not a complete package
manager lockfile.

Lock location is selected in `cts/src/runtime/index.ts`:

| Case | Location | Mode |
| --- | --- | --- |
| `--lock-dir=<dir>` | requested dir | writable only when persisting |
| `cno cache` | project root, else cache dir | writable |
| `run`, `eval`, `repl`, `test` | existing project lock, else cache dir | read-only or memory |
| `--no-lock` | none | memory only |

Read-only stores no-op writes, so runtime commands can call flush paths without
persisting.

## Source And Transform

Source handling lives in `cts/src/source/`.

Transform flow:

```text
read source
  -> OXC transform when available
  -> Sucrase fallback
  -> bytecode cache when enabled
```

`cts/src/source/transform.ts` is the diagnostics boundary. Structured parse or
transform failures should become `TransformError` when line and column are
known.

## Compiler Flow

`ModuleCompiler.load()` dispatches by `ModuleInfo`:

- WASM goes through `WasmCompiler`.
- CJS source goes through `CjsLoader`, then bridges exports to an ESM module.
- ESM, JSON, text, binary, and other non-CJS kinds go through `EsmCompiler`.

CJS requiring ESM uses the sync bridge in `cts/src/compile/bridge.ts`. If
top-level await is unresolved, `require()` must throw instead of returning a
partially evaluated namespace.

## Precache Flow

`cno cache` calls CTS precache methods:

```text
TypeScriptRuntime.runPrecache()
  -> DepScanner scan
  -> lock rewrite
  -> optional node_modules materialization
  -> optional npm lifecycle scripts
  -> worker precompile
  -> resource cleanup
```

No-argument cache seeds from project config and package metadata. Entry cache
seeds both the entry graph and those project specifiers.

## npm Cache And node_modules

npm packages are stored flat:

```text
<cacheDir>/npm/<name>@<version>/
```

`--npm-mode` affects only materialization during `cno cache`:

| Mode | Behavior |
| --- | --- |
| `normal` | Do not write a project `node_modules` |
| `soft` | Create top-level links/junctions into the flat store |
| `hard` | Create per-file hard links, falling back to copies |

The materializer uses the resolved scan graph rather than re-deriving versions
from semver text.

## OXC

`cts/src/oxc.ts` loads the native `oxc` extension when enabled. When it loads:

- dependency scanning can use native import extraction
- TypeScript/JSX transform can use native OXC
- Sucrase remains fallback

Disable with:

```sh
cno run --no-oxc app.ts
CTS_NO_OXC=true cno run app.ts
```

## Cleanup

`TypeScriptRuntime.cleanup()` clears runtime caches and loaded modules only when
there are no pending async loads. Precache always terminates parse workers and
releases registered resources before returning or rethrowing.
