# Native Runtime And Extensions

`circu.js/` is the native runtime core. It embeds QuickJS, uses libuv for the
event loop, and exposes native modules to TypeScript through the
`import.meta.use()` module system.

## Native Core

Important paths:

| Path | Role |
| --- | --- |
| `../circu.js/src/` | Runtime and native modules |
| `../circu.js/types/` | TypeScript declarations for native modules |
| `../circu.js/deps/quickjs/` | QuickJS engine |
| `../circu.js/deps/libuv/` | libuv event loop |
| `../circu.js/deps/wamr/` | WebAssembly runtime |

Native modules commonly follow:

```text
circu.js/src/mod_<name>.c
circu.js/types/<name>.d.ts
```

## import.meta.use()

Runtime TypeScript source loads native modules like:

```ts
const fs = import.meta.use('fs');
const engine = import.meta.use('engine');
```

The root build enables symbol mode for the bundled binary, and
`scripts/bundle.mjs` rewrites access accordingly. Source code should still use
`import.meta.use()`.

## Event Loop

QuickJS owns JavaScript execution. libuv owns I/O, timers, workers, and handle
shutdown.

Keep event loop control centralized in the runtime. Do not introduce ad hoc
`uv_run()` calls outside the established runtime loop and explicit wait helpers.

Close libuv handles with `uv_close()` and let close callbacks run during runtime
teardown.

## Allocation Rules

There are two important allocation families:

```text
tjs__malloc / tjs__free
  global runtime allocation, not tracked by QuickJS

js_malloc / js_free
  QuickJS-runtime-tracked allocation
```

Use QuickJS-tracked allocation for data whose lifetime is tied to JS values and
finalizers while the JS runtime is alive.

Use runtime/global allocation for data that may outlive JS teardown or be freed
from libuv close callbacks.

`uv_queue_work` worker callbacks must not touch QuickJS APIs or QuickJS-tracked
allocation. The worker callback runs off the main thread; QuickJS runtime
allocation accounting is not thread-safe.

## Dynamic Extensions

Dynamic native modules export module metadata consumed by the circu.js loader.
The loader registers them under a module name and then TypeScript can call:

```ts
import.meta.register('name', '/absolute/path/to/module.so');
const mod = import.meta.use('name');
```

Dynamic extensions must match the host QuickJS ABI and symbol visibility rules.

## Static Extension Embedding

The root `CMakeLists.txt` can pass extension metadata into the native core with:

```text
CJS_EXTRA_SOURCES
CJS_EXTRA_INCLUDE_DIRS
CJS_EXTRA_LIBS
CJS_EXTRA_DEFINES
CJS_EXTRA_MODULE_NAMES
CJS_EXTRA_MODULE_INITS
CJS_EXTRA_MODULE_WORKER_SAFE
```

Root options:

```sh
cmake -B build -DCNO_EMBED_EXT_H2=ON
cmake -B build -DCNO_EMBED_EXT_QUIC=ON
```

## OXC Extension

`../ext-oxc/` builds the optional `oxc` native module. CTS uses it through
`cts/src/oxc.ts` for:

- import scanning
- TypeScript/JSX transform

Sucrase remains the fallback path.

OXC is a dynamic extension and must be able to resolve QuickJS `JS_*` symbols
from the host runtime. On Linux this usually means the host must export symbols
with `ENABLE_EXPORTS` or equivalent linker settings.

## HTTP/2 Extension

`../http/ext-h2/` contains the optional HTTP/2 extension. Embed with:

```sh
cmake -B build -DCNO_EMBED_EXT_H2=ON
```

This path requires nghttp2.

## QUIC Extension

`../ext-quic/` contains the optional QUIC extension used by WebTransport and
Deno QUIC integration. Embed with:

```sh
cmake -B build -DCNO_EMBED_EXT_QUIC=ON
```

This path requires the quicly submodule and OpenSSL.

## Type Surface

When a native module API changes, update the matching TypeScript declaration in
`circu.js/types/` or the extension declaration file. Runtime compatibility fixes
should not leave declarations stale.
