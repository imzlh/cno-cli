# cno-cli

`cno-cli` is the integrated command-line runtime built from the projects in
this repository. It runs TypeScript and JavaScript on top of `circu.js`, with a
Deno-like CLI surface, Web APIs, Deno APIs, and a growing Node.js compatibility
layer.

This checkout is a monorepo-style development tree. The runtime that users run
is the final `cno` binary; the subdirectories are the layers that are bundled or
linked into it.

## Repository Layout

| Path | Role |
| --- | --- |
| `src/` | CLI entry point, command dispatch, inspector, setup/cache/test/task commands |
| `cts/` | TypeScript loader: resolution, transform, bytecode cache, CJS/ESM bridge |
| `cno/` | Runtime polyfills: Web API, Deno API, Node.js modules, `CNO` namespace |
| `circu.js/` | Native runtime core: QuickJS, libuv, built-in C modules, `cjsc` |
| `http/` | `@cnojs/http`, low-level protocol helpers used by cno polyfills, server only |
| `ext-oxc/` | Optional native OXC extension for fast transform and import scanning |
| `ext-quic/` | Optional QUIC extension used by WebTransport-related code |
| `tests/` | Runtime tests grouped by compatibility surface |
| `scripts/` | Build helpers, especially the esbuild bundler |

`AGENT.md` is the authoritative maintainer guide for architecture notes, coding
constraints, and repo-specific debugging rules.

## Runtime Shape

The common execution path is:

```text
cno CLI
  -> cts runtime
     -> resolver/source/compiler
     -> cno polyfills
     -> circu.js native runtime
```

Important boundaries:

- `src/main.ts` parses CLI arguments and dispatches commands.
- `src/commands/run.ts` creates a CTS runtime and loads the entry module.
- `cts/src/runtime/index.ts` owns resolver, compiler, lock handling, OXC, and
  precache lifecycle.
- `cts/src/resolve/` maps `file:`, `npm:`, `jsr:`, `http:`, `node:`, and
  `data:` specifiers to `ModuleInfo`.
- `cts/src/compile/` loads ESM, CJS, JSON/text/binary, and WASM.
- `cno/src/main.ts` installs Web API, Deno, CNO, and Node global polyfills.

## Commands

```sh
cno run <file> [args...]
cno <file> [args...]
cno eval "<code>"
cno repl
cno test [paths...]
cno task [name]
cno cache [file]
cno setup
cno exec <bin> [args...]
```

Common flags include:

```sh
--cache-dir=<dir>
--lock-dir=<dir>
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
--npm-mode=normal|soft|hard
--inspect[=host:port]
--inspect-brk[=host:port]
--inspect-wait[=host:port]
```

Deno permission and unstable flags are accepted as compatibility no-ops where
the CLI parser recognizes them.

## Cache And Lock Behavior

`cno cache` is the command that prepares dependency resolution state and writes
`cts.lock`. `run`, `eval`, `repl`, and `test` open an existing project lock
read-only when available, otherwise they use the cache directory or an in-memory
store.

No-argument `cno cache` seeds from `deno.json` imports and
`package.json` dependencies, devDependencies, and optionalDependencies.

`--npm-mode` only affects `cno cache` materialization:

- `normal`: flat CTS cache only.
- `soft`: top-level directory links into the flat cache.
- `hard`: per-file hard links, falling back to copies when needed.

## Development

> [!WARNING]
> if you just want to build it one-step, just try `build.sh` for posix-compatible shells and `build.ps1` for windows.
> Don't forget to install dependencies before building.

Install JavaScript dependencies first:

```sh
pnpm install
```

You are also supposed to install TypeScript dependencies for subprojects:

```sh
sh -c "cd cno && pnpm install"
sh -c "cd cts && pnpm install"
```

Type-check the TypeScript bundle surface (optional):

```sh
pnpm run type-check
```

Configure and build the native binary:

```sh
cmake -B build -DCMAKE_BUILD_TYPE=Release
cmake --build build
```

The staged binary is written to:

```text
build/stage/cno
```

After changing only `cno/src/node/` polyfills, refresh the installed Node
polyfill cache for the staged binary:

```sh
build/stage/cno setup
```

For broader native or bundled changes, rebuild with CMake.

> [!NOTE]
> You can also build the oxc native extension with:
> `cd ext-oxc && cmake -B build -DCMAKE_BUILD_TYPE=Release && cmake --build build`
> and then copy the built library to the `stage/ext` directory.

## Testing

The test runner discovers files matching:

```text
[._]test.[jt]sx?
```

Typical focused test commands:

```sh
build/stage/cno test tests/node
build/stage/cno test tests/deno
build/stage/cno test tests/webapi
build/stage/cno test tests/cts
build/stage/cno test tests/cjs
```

`cno test` runs each test file in a real child process so process and signal
behavior are closer to normal runtime behavior.

## Native Extensions (experimental, non-stable)

The root CMake build can statically embed optional extensions:

```sh
cmake -B build -DCNO_EMBED_EXT_H2=ON
cmake -B build -DCNO_EMBED_EXT_QUIC=ON
```

External extensions can also be placed under the staged extension directory or
loaded through the runtime extension registration path.

## Documentation Map

- `docs/README.md`: documentation index for maintainers.
- `docs/architecture.md`: runtime layers and active execution path.
- `docs/api-surfaces.md`: public and semi-public API surfaces.
- `docs/cli.md`: command routing, flags, and command behavior.
- `docs/compatibility.md`: compatibility status language and support boundaries.
- `docs/module-loading.md`: CTS resolver/compiler/cache/lock behavior.
- `docs/polyfills.md`: Web API, Deno, Node, and CNO compatibility layers.
- `docs/build-test.md`: build, setup, and validation commands.
- `docs/native-extensions.md`: native runtime and extension model.
- `docs/inspector.md`: CDP inspector architecture.
- `AGENT.md`: maintainer and agent rules. Read this before changing code.
- Subproject READMEs: `cts/readme.md`, `cno/readme.md`,
  `circu.js/README.md`, `http/readme.md`, `ext-oxc/README.md`,
  `ext-quic/readme.md`.
