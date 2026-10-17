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
The default CI covers Linux x64/ARM64, macOS x64/ARM64, and Windows x64/ARM64
with OXC.
Enable **all-linux-targets** when starting CI manually to also run the complete
Linux release matrix. `Release` runs when a stable version tag such as `v2.0.0`
is pushed. It reuses `build.yml` for macOS/Windows and `build-linux.yml` for
both Linux container and cross builds. CI checks types,
bundles JavaScript, tests the staged runtime, and uploads its archive. Release
passes `run-tests: false` to both build workflows: it only bundles, compiles,
packages, and publishes. Type checks and runtime tests stay in CI; checks that
Linux linkage and shared dependency bundles match the selected variant remain
part of packaging.
Release verifies and publishes all 34 archives and `SHA256SUMS.txt` after every build
succeeds. No extra repository secrets are required; publication uses
the job's `GITHUB_TOKEN` with `contents: write`.

CI files are grouped by responsibility:

| Location | Purpose |
| --- | --- |
| `.github/workflows/ci.yml`, `release.yml` | Triggers and orchestration |
| `.github/workflows/build.yml`, `build-linux.yml` | Native runners and Linux release jobs |
| `scripts/ci/build.mjs`, `smoke.mjs` | Native build and runtime checks |
| `scripts/ci/linux/` | Container/cross builds, dependency staging, linkage and QEMU helpers |
| `scripts/ci/oxc/` | OXC build, Cargo lockfile and the required sourcemap patch |
| `scripts/ci/verify-release-artifacts.sh` | Complete release archive inventory |
| `cmake/ci/` | Static/shared Linux dependency settings |
| `tests/ci/` | CI helper regression tests and runtime fixtures |

The Linux `verify.sh` checks both static and shared releases. Shell smoke tests
serve target containers without Node.js; native runners use `smoke.mjs`.

| Archive | Targets | Build environment |
| --- | --- | --- |
| `cno-linux-<arch>.tar.gz` | x86_64, i386, arm64, armv7, armv6 | Debian 12 (bookworm); glibc |
| `cno-linux-glibc-minimal-<arch>.tar.gz` | x86_64, i386, arm64, armv7, armv6 | Debian 12 (bookworm); glibc, external shared libraries in `lib/` |
| `cno-linux-musl-<arch>.tar.gz` | x86_64, i386, arm64, armv7, armv6 | Alpine 3.21; static musl |
| `cno-linux-musl-<arch>.tar.gz` | mips, mipsel, mips64, riscv64, armv5 | Cross toolchains, vcpkg, and QEMU; static musl |
| `cno-linux-musl-dynamic-<arch>.tar.gz` | x86_64, i386, arm64, armv7, armv6 | Alpine 3.21; dynamic musl, external shared libraries in `lib/` |
| `cno-linux-musl-dynamic-<arch>.tar.gz` | mips, mipsel, mips64, riscv64, armv5 | Cross toolchains, vcpkg, and QEMU; dynamic musl, external shared libraries in `lib/` |
| `cno-macos-arm64.tar.gz` | arm64 | `macos-15`; Homebrew libraries |
| `cno-macos-x86_64.tar.gz` | x86_64 | `macos-15-intel`; Homebrew libraries |
| `cno-windows-x64.zip` | x64 | `windows-2022`; vcpkg runtime DLLs included |
| `cno-windows-arm64.zip` | arm64 | `windows-11-arm`; vcpkg runtime DLLs included |

The glibc release archives target Debian 12 or compatible distributions. Standard
`cno-linux-<arch>` archives require their system libraries; `glibc-minimal`
archives bundle external shared dependencies as described below. Default CI's
Linux artifacts use Ubuntu 24.04 instead; release builds preserve the Debian
baseline. macOS packages depend on Homebrew's libffi, sqlite, openssl@3, zlib,
expat, curl, and brotli. Install
these dependencies before running an archive on a different machine.

Every CI/release archive includes OXC in `ext/` (`oxc.dll`, `oxc.dylib`, or
`oxc.so`). Dynamic runtimes use it for transformation, and CI verifies both
native OXC and the `--no-oxc` Sucrase fallback. Static musl cannot load shared
extensions: its runtime uses Sucrase, while the included `ext/oxc.so` is a
companion for the matching dynamic musl runtime. Keeping OXC separate avoids
increasing the core executable's size.

Static musl archives statically link native dependencies and compiler runtimes.
Only standard releases retain native Brotli support. `glibc-minimal`, `musl`
and `musl-dynamic` disable it, including libcurl's Brotli decoder. Container
builds use a private libcurl built without Brotli; cross builds use vcpkg's
curl without its optional `brotli` feature. HTTPS, gzip/deflate and the other
configured compression libraries remain available. Shared dependency staging
rejects any transitive Brotli library in these variants.

The `musl-dynamic` and `glibc-minimal` variants dynamically link external
libraries such as curl, OpenSSL, SQLite, libffi, expat and zlib, and ship those
libraries and their transitive dependencies under `lib/`. The bundled sources
under `circu.js/deps` remain statically linked into the runtime. The target OS
supplies libc and the dynamic loader; neither is included in the archive.
`lib/DEPENDENCIES.txt` lists the bundled SONAMEs and required system libc.
Packaging checks that the shared dependency bundle is complete.

Executable-relative RPATH entries make the runtime and OXC find the archive's
`lib/` directory after extraction or relocation. You can remove individual
libraries from `lib/`, or remove the directory entirely, when the target system
provides compatible libraries with the same SONAME and ABI. Missing bundled
libraries then resolve through the system loader's normal search paths. Install
all required replacement dependencies before removing the bundled copies.

Choose the matching CPU, endianness and floating-point ABI for Alpine/OpenWrt;
mipsel requires MIPS32r2 with the o32 hard-float ABI. Static and dynamic builds
use separate CMake and vcpkg installation directories, and independent workflow
jobs.

Linux OXC uses Rust 1.95.0, explicit Rust target triples, and the lockfile under
`scripts/ci/oxc/`. The host builds the Rust archive; the target container or
cross compiler links the C module. This supports 32-bit Alpine without needing
a Rust host toolchain inside its container. MIPS/MIPSel/MIPS64 have no prebuilt
Rust standard library and use pinned `nightly-2026-10-15` with `rust-src` and
`build-std`. These cross builds must pass QEMU smoke tests in full-matrix CI;
Rust target availability alone does not establish compatibility with the old
musl.cc sysroot. Build failures are not converted into missing extensions.
WebAssembly is disabled on MIPS targets whose endianness or ABI is unsupported
by the bundled WAMR; the
CLI still starts without the optional native module.

All CI builds minify the JavaScript bundle and strip embedded bytecode debug
data. Native size optimization, section garbage collection, and supported LTO
remain enabled. Linux packages record their build details in `BUILD-INFO.txt`.

The host generates the JavaScript bundle before entering Linux containers or
cross builds, so target images need no Node.js/pnpm installation. ARMv6 glibc
uses the existing `arm32v5/debian` image with ARMv6 compiler flags. Targets
without Alpine images use real cross toolchains. Big-endian targets must run
the target bytecode compiler through QEMU; host bytecode is not interchangeable.
Cross toolchain downloads use the fixed `tsl0922/musl-toolchains` GitHub release
`2021-11-23`, with musl.cc as a fallback. Both sources serve the same archives,
verified against `scripts/ci/linux/musl-toolchains.sha512`. Downloads have bounded
timeouts, and cached archives are verified before reuse.

Dynamic cross builds prepare a private QEMU runtime root from GCC's `libc.so`
and the built bytecode compiler's ELF interpreter path, then stage its shared
compiler runtime dependencies into that root. This avoids relying on
missing or non-relocatable loader links in the toolchain archive. All target
bytecode compilers and smoke tests use that runtime root; the compiler sysroot
and the release executable's interpreter remain unchanged.

JavaScript installation uses `packageManager` in `package.json` and the three
committed `pnpm-lock.yaml` files. Keep these lockfiles with dependency changes.
The Windows vcpkg checkout in `build.yml` must match `builtin-baseline` in
`vcpkg.json`. Windows CI uses the `x64-windows-release` or
`arm64-windows-release` overlay triplet and installs into
`build/vcpkg_installed/`, avoiding unused Debug builds and keeping developer
dependencies separate. The seven manifest libraries are all required by the
runtime; removing them would disable functionality or fail configuration.
Compiled vcpkg packages use an explicit file binary cache persisted by Actions,
keyed by runner, architecture, MSVC/SDK version, manifest and triplets. Compatible
packages remain reusable after manifest changes because vcpkg checks their ABI.
If a later native or OXC build fails, completed Windows dependency packages
are still saved under a partial key for the next run to reuse.
Native jobs also cache Cargo downloads and Corrosion's actual
`build/oxc-ci/cargo/` output, keyed by target, toolchain and OXC build inputs.
Linux container jobs cache their host Rust output; musl cross jobs cache Rust
output and vcpkg binary packages. Static and dynamic musl share the PIC Rust
cache, as do standard and minimal glibc, while native dependency caches retain
separate linkage keys.
CMake build trees and installed dependency snapshots are not cached.

Submodule source fixes must be committed and pushed in their own
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

In CMake Tools, select the automatically detected Visual Studio x64 kit. The
Windows workspace settings use `scripts/cmake-utf8.cmd` to enable UTF-8 before
starting CMake; it locates CMake on `PATH` or through Visual Studio Installer.
This keeps localized MSVC diagnostics and Ninja's `/showIncludes` dependency
tracking readable even when the editor starts the tools without a console.
Keep the checkout path free of spaces when using this CMake Tools setup:
the extension invokes `.cmd` wrappers through a shell without preserving
quotes around their paths and arguments.
After updating from a configuration whose compiler output contained `????`,
run **Delete Cache and Reconfigure** once to refresh the cached include prefix.
`build.ps1` also sets UTF-8 output. pnpm is found on `PATH`; an obsolete cached
pnpm path is discarded automatically during configuration.

For a manual Debug configuration, run this from an x64 developer shell:

```powershell
cmake -S . -B build -G Ninja -DCMAKE_BUILD_TYPE=Debug `
  "-DCMAKE_TOOLCHAIN_FILE=cmake/vcpkg-toolchain.cmake" `
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

Outside a checkout, `cno setup` fetches Node polyfills at the exact cno submodule
commit embedded when the CLI was bundled. It refreshes an installed cache when
that bundled revision changes. To deliberately install another immutable
revision (including when running inside a checkout), use:

```sh
cno setup --polyfill-revision=<full-40-character-commit-sha>
```

Branch names are rejected. Source archives without Git metadata must set
`CNO_POLYFILL_REVISION` to the original full cno commit SHA before bundling.
The offline setup regression tests run with
`node --test tests/cts/setup-polyfill.test.mjs`.

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
