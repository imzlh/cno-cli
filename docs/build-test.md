# Build And Test

This document covers the common development commands for this checkout.

## Dependencies

Install JavaScript dependencies from the repository root:

```sh
git submodule update --init --recursive
pnpm install --frozen-lockfile
pnpm --dir cno install --frozen-lockfile
pnpm --dir cts install --frozen-lockfile
```

The root build requires:

- CMake
- a C compiler
- pnpm
- a host `cjsc` when cross-compiling, or the ability to build one

Optional extensions may require extra dependencies such as Rust, OpenSSL, or
nghttp2.

## GitHub Actions

`CI` runs on branch pushes, pull requests, and manual **Run workflow** requests.
The default CI covers Linux x64/ARM64, macOS ARM64, and Windows x64 with OXC.
Enable **all-linux-targets** when starting CI manually to also run the complete
Linux release matrix. `Release` runs when a stable version tag such as `v2.0.0`
is pushed. It reuses `build.yml` for macOS/Windows, `build-linux.yml` for Linux
containers, and `build-cross-linux.yml` for Linux cross builds. Every build
checks and bundles JavaScript, tests the staged runtime, and uploads its archive.
Release publishes all 17 archives and `SHA256SUMS.txt` only after every build
and test succeeds. No extra repository secrets are required; publication uses
the job's `GITHUB_TOKEN` with `contents: write`.

| Archive | Targets | Build environment |
| --- | --- | --- |
| `cno-linux-<arch>.tar.gz` | x86_64, i386, arm64, armv7, armv6 | Debian 12 (bookworm); glibc |
| `cno-linux-musl-<arch>.tar.gz` | x86_64, i386, arm64, armv7, armv6 | Alpine 3.21; static musl |
| `cno-linux-musl-<arch>.tar.gz` | mips, mipsel, mips64, riscv64, armv5 | Cross toolchains, vcpkg, and QEMU; static musl |
| `cno-macos-arm64.tar.gz` | arm64 | `macos-15`; Homebrew libraries |
| `cno-windows-x64.zip` | x64 | `windows-2022`; vcpkg runtime DLLs included |

The glibc release archives target Debian 12 or compatible distributions and
require their system libraries. Default CI's Linux artifacts use Ubuntu 24.04
instead; release builds preserve the Debian baseline. macOS packages depend
on Homebrew's libffi, sqlite, openssl@3, zlib, expat, curl, and brotli. Install
these dependencies before running an archive on a different machine.

Linux release packages use the bundled Sucrase transformer. Static musl does
not support loading shared extensions. macOS/Windows releases include OXC,
and their smoke tests verify both OXC and Sucrase. WebAssembly is disabled on
MIPS targets whose endianness or ABI is unsupported by the bundled WAMR; the
CLI still starts without the optional native module.

The host generates the JavaScript bundle before entering Linux containers or
cross builds, so target images need no Node.js/pnpm installation. ARMv6 glibc
uses the existing `arm32v5/debian` image with ARMv6 compiler flags. Targets
without Alpine images use real cross toolchains. Big-endian targets must run
the target bytecode compiler through QEMU; host bytecode is not interchangeable.

JavaScript installation uses `packageManager` in `package.json` and the three
committed `pnpm-lock.yaml` files. Keep these lockfiles with dependency changes.
The Windows vcpkg checkout in `build.yml` must match `builtin-baseline` in
`vcpkg.json`. Submodule source fixes must be committed and pushed in their own
repositories before pushing the main repository's updated gitlinks; otherwise
GitHub cannot check out those commits.

To reproduce the CI build after installing its platform dependencies and Rust,
run from a developer shell (an x64 MSVC shell on Windows):

```sh
node scripts/ci/build.mjs build-ci
node scripts/ci/smoke.mjs build-ci/stage
```

On macOS, supply the Homebrew prefixes through `CNO_CMAKE_PREFIX_PATH` as in
the workflow. The smoke script creates a private cache, installs Node
polyfills from this checkout, checks the native OXC transform and the Sucrase
fallback, and runs the CLI flag regression tests. Missing artifacts, native
load failures, nonzero exits, and timeouts fail the job.

### Windows native dependencies

The root `vcpkg.json` declares the required native libraries and pins the vcpkg
registry baseline. VS Code's CMake configuration and `build.ps1` both use
`cmake/vcpkg-toolchain.cmake`. It finds an explicit `VCPKG_ROOT` first, then the
vcpkg installation bundled with Visual Studio, so moving Visual Studio does
not require hard-coded drive paths in the project.

Install Visual Studio's C++ build tools, Windows SDK, and vcpkg component.
Then run `./build.ps1` from PowerShell, or configure/build with VS Code CMake
Tools. CMake runs `vcpkg install` automatically and installs the manifest's
dependencies into `vcpkg_installed/`, reusing the vcpkg binary cache when
compatible. Both Debug and Release libraries are installed. The build stages
the DLLs required by the selected configuration alongside `cno.exe`.

For a manual Debug configuration, run this from an x64 developer shell:

```powershell
cmake -S . -B build -G Ninja -DCMAKE_BUILD_TYPE=Debug `
  -DCMAKE_TOOLCHAIN_FILE=cmake/vcpkg-toolchain.cmake `
  -DVCPKG_TARGET_TRIPLET=x64-windows
cmake --build build --parallel
```

When switching from a configuration that did not use this toolchain, add
`--fresh` to the first configure command, or use CMake Tools' **Delete Cache
and Reconfigure** once. Setting `VCPKG_TARGET_TRIPLET` alone does not enable
vcpkg or make `find_package()` search its libraries.

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

`CNO_PREBUILT_BUNDLE=/absolute/path/to/cno-cli.js` skips the Node/pnpm step
when the host has already built the bundle. Bytecode generation still uses
the compiler selected by `CJSC_PATH` or the native build.

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
