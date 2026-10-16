# OXC release builds

The upstream `ext-oxc` submodule supplies the Rust implementation and C glue.
This directory owns the release CMake configuration and Cargo lockfile. Both
CMake and `build-oxc-linux.sh --prepare` copy this lock into the submodule's
ignored `Cargo.lock` before invoking Cargo with `--locked`. When updating OXC,
update the submodule and this lockfile together. The locked OXC 0.138 dependency
graph requires Rust 1.95.

Linux builds compile the pure-Rust archive on the CI host, then link the C
glue with the target's compiler. Alpine's 32-bit containers do not need a
native Rust host compiler:

```sh
sh scripts/ci/build-oxc-linux.sh --prepare musl armv7 build-oxc-rust
# Inside the target container, with the checkout and archive mounted:
CNO_OXC_RUST_ARCHIVE="$PWD/build-oxc-rust/libcjs_oxc_core.a" \
  sh scripts/ci/build-oxc-linux.sh musl armv7 build-linux/stage
```

The helper maps glibc/musl x86_64, i386, ARM64, ARMv7 and ARMv6, plus musl
ARMv5, RISC-V 64, MIPS, MIPSEL and MIPS64. ARMv6 glibc uses soft-float;
ARMv6 musl uses hard-float. MIPS targets are Rust tier 3 and rebuild `std`
with a pinned nightly compiler; MIPS32 explicitly uses the toolchain's
hard-float o32 ABI. Their build and target smoke tests must pass
before release. `CNO_OXC_RUST_TOOLCHAIN` and `CNO_OXC_RUST_NIGHTLY` can
override the helper's pinned compiler versions.

The prepared archive uses PIC and disables musl's default static CRT. For
manual CMake builds, pass `CJS_DIR` and
`-DCJS_OXC_RUST_ARCHIVE=/absolute/path/to/libcjs_oxc_core.a` to skip Rust and
Corrosion entirely. This option is Linux-only. When using Corrosion for
cross compilation, set `Rust_CARGO_TARGET` explicitly; GCC target triples
are not Rust target names.

`ext/oxc.so` stays separate from `cno`. Fully static musl runtimes cannot
load shared native modules and use Sucrase even if the package includes
OXC. Use the matching dynamic musl runtime to use the companion module.
