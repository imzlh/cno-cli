# API Surfaces

This document lists the API surfaces that users or downstream code can observe.
It is an index, not a full reference for every function.

When changing behavior, update the closest implementation and the closest public
surface together.

## CLI Surface

The CLI surface is owned by `../src/cli.ts` and `../src/main.ts`.

Commands:

| Command | Owner | Public behavior |
| --- | --- | --- |
| `cno run <file>` | `../src/commands/run.ts` | Run a module entry |
| `cno <file>` | `../src/main.ts` | Implicit run |
| `cno eval <code>` | `../src/commands/eval.ts` | Evaluate source text |
| `cno repl` | `../src/commands/repl/` | Interactive evaluator |
| `cno test [paths]` | `../src/commands/test.ts` | Discover and run test files |
| `cno task [name]` | `../src/commands/task.ts` | Run configured tasks |
| `cno cache [file]` | `../src/commands/cache.ts` | Resolve/cache dependency graph |
| `cno setup` | `../src/commands/setup.ts` | Install Node polyfill files |
| `cno exec <bin>` | `../src/commands/bin.ts` | Run resolved package binaries |

Recognized but not implemented:

```text
fmt, lint, upgrade
```

## CLI Flags

Runtime-impacting flags:

```text
--cache-dir
--lock-dir
--no-lock
--frozen
--reload
--precache
--no-http
--no-jsr
--no-node
--no-oxc
--disable-cache
--ignore-scripts
--npm-mode
--silent
--system-proxy
--skip-cert-verify
--memory-limit
--max-stack-size
--inspect
--inspect-brk
--inspect-wait
```

Deno compatibility flags accepted as no-ops are listed in `../src/cli.ts`.
Additions there should be reflected in `docs/cli.md` when they affect user
expectations.

## Environment Variables

CTS/runtime configuration:

```text
CTS_CACHE_DIR
CTS_LOCK_DIR
CTS_DISABLE_CACHE
CTS_ENABLE_HTTP
CTS_ENABLE_JSR
CTS_ENABLE_NODE
CTS_ENABLE_OXC
CTS_NO_OXC
CTS_SILENT
CTS_MEMORY_LIMIT
CTS_MAX_STACK_SIZE
CTS_JSR_CACHE_TTL
CTS_REQUEST_TIMEOUT
CTS_WORKERS
```

Network and registry behavior:

```text
NPM_CONFIG_REGISTRY
NPM_TOKEN
DEBUG
```

Native/runtime-specific variables exist in lower layers. Document them near the
owning implementation when they are not general CLI behavior.

## Config Files

`cts/src/config.ts` reads project config from:

| File | Used for |
| --- | --- |
| `tsconfig.json` | path aliases and baseUrl |
| `deno.json`, `deno.jsonc` | imports, importMap, compilerOptions paths |
| `package.json` | imports and `cts.nodeModulesMode` |

`src/commands/cache.ts` additionally reads project dependency declarations for
no-entry cache seeding:

```text
dependencies
devDependencies
optionalDependencies
```

## Module Specifier Surface

CTS supports these specifier families:

| Specifier | Owner |
| --- | --- |
| relative/absolute file paths | `../cts/src/resolve/protocols/file.ts` |
| `file:` | `../cts/src/resolve/protocols/file.ts` |
| `npm:` | `../cts/src/resolve/protocols/npm.ts` |
| bare npm package names | `../cts/src/resolve/protocols/npm.ts` |
| `jsr:` | `../cts/src/resolve/protocols/jsr.ts` |
| `@std/*` | `../cts/src/resolve/index.ts` to JSR |
| `http:`, `https:` | `../cts/src/resolve/protocols/http.ts` |
| `node:` | `../cts/src/resolve/protocols/node.ts` |
| builtin aliases | `../cts/src/resolve/builtins.ts` |
| `data:` | `../cts/src/resolve/protocols/data.ts` |

When adding a public specifier form, update resolver docs and tests.

## Runtime Global Surface

Installed before user code:

| Global or namespace | Owner |
| --- | --- |
| Web APIs | `../cno/src/webapi/index.ts` |
| `Deno` | `../cno/src/deno/index.ts` |
| `CNO` | `../cno/src/cno/index.ts` |
| `process` | `../cno/src/node/_internal/inject.ts` |
| `Buffer` | `../cno/src/node/_internal/inject.ts` |

Node builtin modules are resolved through CTS and implemented under
`../cno/src/node/`.

## Native Module Surface

Native modules exposed through `import.meta.use()` are implemented under:

```text
../circu.js/src/mod_*.c
```

The TypeScript declarations are under:

```text
../circu.js/types/
```

Any native API change should include the matching declaration update and a
runtime validation path.

## Extension Surface

| Extension | Module name | Owner |
| --- | --- | --- |
| OXC | `oxc` | `../ext-oxc/` and `../cts/src/oxc.ts` |
| HTTP/2 | `@cnojs/http/ext-h2` | `../http/ext-h2/` |
| QUIC | `@cnojs/quic` | `../ext-quic/` |

Extensions can be dynamically loaded or statically embedded depending on build
configuration.

## Test Surface

Public behavior should be validated in the closest test bucket:

| Surface | Tests |
| --- | --- |
| CTS loader and cache | `../tests/cts/` |
| CJS interop | `../tests/cjs/` |
| Deno APIs | `../tests/deno/` |
| Node APIs | `../tests/node/` |
| Web APIs | `../tests/webapi/` |

Temporary or generated regression-style tests should not become the default
documentation source. Prefer durable behavior tests in these buckets.
