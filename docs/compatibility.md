# Compatibility

This project aims to run Deno-style TypeScript and a useful subset of Node.js
and Web platform code on top of `circu.js`. Compatibility is practical and
incremental, not a claim that every upstream runtime API is complete.

Use precise status language in docs and code review.

## Status Words

| Word | Meaning |
| --- | --- |
| implemented | The API or module exists and has intentional behavior |
| partial | Important behavior exists, but upstream compatibility is incomplete |
| stub | The API exists mostly to unblock imports or feature detection |
| unsupported | The API should not be expected to work |
| native-backed | Behavior depends on a circu.js native module |
| extension-backed | Behavior depends on an optional native extension |

Avoid using a module directory as proof of full compatibility. A directory under
`cno/src/node/` means there is an implementation entry point; tests and runtime
behavior decide the compatibility claim.

## Main Compatibility Areas

| Area | Owner | Tests |
| --- | --- | --- |
| Web API | `../cno/src/webapi/` | `../tests/webapi/` |
| Deno API | `../cno/src/deno/` | `../tests/deno/` |
| Node builtins | `../cno/src/node/` | `../tests/node/` |
| CJS/ESM interop | `../cts/src/compile/` | `../tests/cjs/`, `../tests/cts/` |
| npm/jsr/http modules | `../cts/src/resolve/` | `../tests/cts/` |
| Native modules | `../circu.js/src/` | focused runtime or integration tests |

## Web API Compatibility

Web API implementations are installed from `cno/src/webapi/index.ts`.

Commonly used areas include:

- events
- URL APIs
- streams
- fetch primitives
- WebSocket and EventSource
- crypto and WebCrypto pieces
- performance
- storage and cache-related pieces
- workers and messaging
- navigator-related surfaces

Fetch shape compatibility belongs in `cno/src/webapi/fetch/`. Raw protocol
behavior belongs in `http/` or native modules.

## Deno Compatibility

The `Deno` namespace is assembled in `cno/src/deno/index.ts`.

Important caveat: permission behavior is compatibility-oriented and currently
not a sandbox. CLI permission flags are accepted as no-ops where recognized.

When documenting Deno APIs, separate:

- namespace shape
- runtime behavior
- permission behavior
- platform behavior

## Node Compatibility

Node builtin modules live under `cno/src/node/`.

The resolver maps `node:` and known builtin aliases to cached polyfill files.
The setup command installs those files to:

```text
<cacheDir>/node
```

Node compatibility should be fixed at the shared primitive when possible. For
example, stream, EventEmitter, buffer, HTTP parser/dispatch, and child process
behavior should not be patched package-by-package when the failure is a common
Node semantic.

## npm Compatibility

npm package loading is implemented by CTS, not by a real `node_modules` tree by
default.

Default layout:

```text
<cacheDir>/npm/<name>@<version>/
```

Some tools need a filesystem `node_modules`; `cno cache --npm-mode=soft|hard`
materializes one from the resolved scan graph.

Compatibility risks to document when relevant:

- packages that inspect filesystem layout
- packages with lifecycle scripts
- native addon packages
- packages that rely on exact Node builtin semantics
- packages that use child processes or package binaries

## Inspector Compatibility

The inspector is CDP-compatible enough for debugging workflows, but discovery
shape, target type, pause semantics, and object lifetime should be tested
against the specific frontend or protocol expectation being changed.

Relevant code lives under:

```text
../src/inspector/
../circu.js/src/mod_debug.c
```

## Platform Compatibility

The runtime targets multiple platforms, but individual APIs can be platform
sensitive:

- path behavior
- symlink and junction behavior
- executable file mode
- process spawning
- signals
- pty
- sockets and Unix sockets
- native extension loading

When adding tests, prefer cross-platform assertions unless the behavior is
explicitly platform-specific.

## Documentation Rule

When updating compatibility docs:

1. Name the owner file or directory.
2. Say whether the behavior is implemented, partial, stubbed, or unsupported.
3. Name the closest test bucket.
4. Avoid claiming upstream parity unless tests cover the claim.
