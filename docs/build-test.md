# Build And Test

This document covers the common development commands for this checkout.

## Dependencies

Install JavaScript dependencies from the repository root:

```sh
pnpm install
```

The root build requires:

- CMake
- a C compiler
- pnpm
- a host `cjsc` when cross-compiling, or the ability to build one

Optional extensions may require extra dependencies such as Rust, OpenSSL, or
nghttp2.

## Type Check

Run the bundled TypeScript surface check:

```sh
pnpm run type-check
```

Subprojects may also have their own type-check scripts, but root type-check is
the normal first pass for CLI/runtime TypeScript changes.

## Native Build

Configure:

```sh
cmake -B build -DCMAKE_BUILD_TYPE=Release
```

Build:

```sh
cmake --build build
```

The staged runtime binary is:

```text
build/stage/cno
```

## Bundle Flow

The root `CMakeLists.txt`:

1. builds `circu.js`
2. builds or finds `cjsc`
3. runs `pnpm run bundle` or `pnpm run bundle:min`
4. converts the JS bundle into bytecode data
5. links the final staged `cno` binary

The bundle script is:

```text
scripts/bundle.mjs
```

Source code should use `import.meta.use()`. The release bundle rewrites that
access for symbol mode.

## Build Options

Common root options:

```sh
-DCNO_BUNDLE_MINIFY=ON
-DCNO_EMBED_EXT_H2=ON
-DCNO_EMBED_EXT_QUIC=ON
-DCJSC_PATH=/abs/path/to/cjsc
-DCNO_EXT_DIR=/abs/path/to/ext
```

`CNO_EMBED_EXT_H2` requires nghttp2. `CNO_EMBED_EXT_QUIC` requires the quicly
submodule and OpenSSL.

## Setup After Node Polyfill Changes

If only `cno/src/node/` changed, refresh the staged Node polyfill cache:

```sh
build/stage/cno setup
```

Broader changes usually need a rebuild.

## Test Runner

Run tests with:

```sh
build/stage/cno test [paths...]
```

The runner discovers:

```text
[._]test.[jt]sx?
```

Each test file runs in a child process. Default concurrency is 4 unless
overridden:

```sh
build/stage/cno test tests/node --concurrency=8
```

## Test Buckets

Focused buckets:

```sh
build/stage/cno test tests/cjs
build/stage/cno test tests/cts
build/stage/cno test tests/deno
build/stage/cno test tests/node
build/stage/cno test tests/webapi
```

Prefer running the smallest bucket that covers the behavior changed. For shared
runtime changes, combine relevant buckets.

## Cache Validation

Cache behavior is normally validated with:

```sh
build/stage/cno cache
build/stage/cno cache <entry>
build/stage/cno cache --npm-mode=soft
build/stage/cno cache --npm-mode=hard
```

Be careful when interpreting sandbox failures. Read-only cache paths, blocked
localhost listeners, or restricted network access can look like runtime
failures.

## Debug Logging

Use `DEBUG` categories:

```sh
DEBUG=* build/stage/cno run app.ts
DEBUG=resolver,npm,jsr build/stage/cno run app.ts
DEBUG=precache,deps build/stage/cno cache
DEBUG=loader,transformer build/stage/cno run app.ts
```

Keep new debug logs sparse. Prefer one-shot summaries or first-hit markers in
noisy resolver/precache paths.
