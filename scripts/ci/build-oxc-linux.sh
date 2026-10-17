#!/bin/sh
set -eu

# Build the pure-Rust archive on a Rust-supported host, then link the C glue
# using the target compiler. This also covers Alpine's 32-bit targets, for
# which rustup does not publish a native musl-hosted compiler.
usage() {
    printf '%s\n' \
        'Usage: build-oxc-linux.sh --prepare glibc|musl target output-dir' \
        '       build-oxc-linux.sh glibc|musl target stage-dir [build-dir]' >&2
    exit 2
}

prepare_only=false
if [ "${1:-}" = --prepare ]; then
    prepare_only=true
    shift
fi
[ "$#" -ge 3 ] && [ "$#" -le 4 ] || usage
if [ "$prepare_only" = true ] && [ "$#" -ne 3 ]; then usage; fi
libc=$1
target=$2
root=$(CDPATH= cd -- "$(dirname -- "$0")/../.." && pwd)

# These are Rust target names, never the output of GCC -dumpmachine. In
# particular ARMv6 glibc uses Debian armel's soft-float ABI, while Alpine armhf
# uses hard-float; the ARMv5 musl.cc toolchain is soft-float.
tier3=false
case "$libc/$target" in
    glibc/x86_64) rust_target=x86_64-unknown-linux-gnu ;;
    glibc/i386) rust_target=i686-unknown-linux-gnu ;;
    glibc/arm64) rust_target=aarch64-unknown-linux-gnu ;;
    glibc/armv7) rust_target=armv7-unknown-linux-gnueabihf ;;
    glibc/armv6) rust_target=arm-unknown-linux-gnueabi ;;
    musl/x86_64) rust_target=x86_64-unknown-linux-musl ;;
    musl/i386) rust_target=i686-unknown-linux-musl ;;
    musl/arm64) rust_target=aarch64-unknown-linux-musl ;;
    musl/armv7) rust_target=armv7-unknown-linux-musleabihf ;;
    musl/armv6) rust_target=arm-unknown-linux-musleabihf ;;
    musl/armv5) rust_target=armv5te-unknown-linux-musleabi ;;
    musl/riscv64) rust_target=riscv64gc-unknown-linux-musl ;;
    musl/mips) rust_target=mips-unknown-linux-musl; tier3=true ;;
    musl/mipsel) rust_target=mipsel-unknown-linux-musl; tier3=true ;;
    musl/mips64) rust_target=mips64-unknown-linux-muslabi64; tier3=true ;;
    *) printf 'Unsupported OXC target: %s/%s\n' "$libc" "$target" >&2; exit 2 ;;
esac

prepare_rust() {
    output=$1
    mkdir -p "$output"
    output=$(CDPATH= cd -- "$output" && pwd)
    command -v rustup >/dev/null
    cp "$root/scripts/ci/oxc/Cargo.lock" "$root/ext-oxc/Cargo.lock"
    # The locked OXC dependencies require 1.95. MIPS is tier 3: Rust has target specifications
    # but publishes no std component, so only those targets rebuild std.
    if [ "$tier3" = true ]; then
        toolchain=${CNO_OXC_RUST_NIGHTLY:-nightly-2026-10-15}
        rustup toolchain install "$toolchain" --profile minimal --no-self-update --component rust-src
        set -- -Z build-std=std,panic_abort
    else
        toolchain=${CNO_OXC_RUST_TOOLCHAIN:-1.95.0}
        rustup toolchain install "$toolchain" --profile minimal --no-self-update --target "$rust_target"
        set --
    fi
    # Never bundle the musl CRT into the shared module. Setting these flags for
    # every crate also keeps ARM/MIPS static archives suitable for a .so link.
    oxc_rustflags="${RUSTFLAGS:+$RUSTFLAGS }-Crelocation-model=pic"
    if [ "$libc" = musl ]; then
        target_features=-crt-static
        case "$target" in
            # Rust's MIPS32 musl targets default to soft-float, but the
            # musl.cc compiler and WAMR use the o32 hard-float ABI. This flag
            # must apply to rebuilt std as well as the OXC crates.
            mips|mipsel) target_features="$target_features,-soft-float" ;;
        esac
        oxc_rustflags="$oxc_rustflags -Ctarget-feature=$target_features -Clink-self-contained=no"
    fi
    (
        # Cargo discovers .cargo/config.toml from cwd, not --manifest-path.
        # Keep the library-only sourcemap patch active even when invoked elsewhere.
        cd "$root"
        unset CARGO_ENCODED_RUSTFLAGS
        RUSTFLAGS="$oxc_rustflags" cargo "+$toolchain" rustc "$@" \
            --manifest-path "$root/ext-oxc/Cargo.toml" --locked --release --lib \
            --target "$rust_target" --target-dir "$output/cargo" -- --print native-static-libs
    )
    cp "$output/cargo/$rust_target/release/libcjs_oxc_core.a" "$output/libcjs_oxc_core.a"
    printf '%s\n' "$rust_target" > "$output/rust-target.txt"
    printf '%s\n' "$toolchain" > "$output/rust-toolchain.txt"
}

if [ "$prepare_only" = true ]; then
    prepare_rust "$3"
    exit
fi

stage=$3
build=${4:-"$root/build-oxc-$libc-$target"}
mkdir -p "$build" "$stage/ext"
build=$(CDPATH= cd -- "$build" && pwd)
stage=$(CDPATH= cd -- "$stage" && pwd)
archive=${CNO_OXC_RUST_ARCHIVE:-}
if [ -z "$archive" ]; then
    prepare_rust "$build/rust"
    archive="$build/rust/libcjs_oxc_core.a"
fi
[ -f "$archive" ] || { printf 'Missing OXC Rust archive: %s\n' "$archive" >&2; exit 1; }
archive=$(CDPATH= cd -- "$(dirname -- "$archive")" && pwd)/$(basename -- "$archive")

if [ -n "${CNO_CROSS_TRIPLE:-}" ]; then
    cc=${CC:-"${CNO_CROSS_ROOT:?}/bin/$CNO_CROSS_TRIPLE-gcc"}
    ar=${AR:-"$CNO_CROSS_ROOT/bin/$CNO_CROSS_TRIPLE-ar"}
    strip=${STRIP:-"$CNO_CROSS_ROOT/bin/$CNO_CROSS_TRIPLE-strip"}
    readelf=${READELF:-"$CNO_CROSS_ROOT/bin/$CNO_CROSS_TRIPLE-readelf"}
else
    cc=${CC:-cc}
    ar=${AR:-ar}
    strip=${STRIP:-strip}
    readelf=${READELF:-readelf}
fi
case "$target" in
    mips|mipsel)
        printf '%s\n' \
            '#if !defined(__mips_hard_float) || _MIPS_SIM != _ABIO32' \
            '#error OXC requires the MIPS o32 hard-float ABI' \
            '#endif' | "$cc" -x c -E - >/dev/null
        ;;
    mips64)
        printf '%s\n' \
            '#if !defined(__mips_hard_float) || _MIPS_SIM != _ABI64' \
            '#error OXC requires the MIPS n64 hard-float ABI' \
            '#endif' | "$cc" -x c -E - >/dev/null
        ;;
esac
set -- -S "$root/scripts/ci/oxc" -B "$build/native" -G Ninja \
    -DCMAKE_BUILD_TYPE=Release -DCMAKE_SYSTEM_NAME=Linux \
    -DCMAKE_C_COMPILER="$cc" -DCMAKE_AR="$ar" \
    -DCJS_DIR="$root/circu.js" -DCJS_OXC_RUST_ARCHIVE="$archive" \
    -DCJS_OXC_SHARED_RUNTIME="${CNO_OXC_SHARED_RUNTIME:-false}" \
    -DCMAKE_POSITION_INDEPENDENT_CODE=ON
if [ -n "${CNO_CROSS_SYSROOT:-}" ]; then
    set -- "$@" -DCMAKE_SYSROOT="$CNO_CROSS_SYSROOT"
fi
if [ "$libc/$target" = glibc/armv6 ]; then
    set -- "$@" '-DCMAKE_C_FLAGS=-march=armv6 -mfloat-abi=soft'
fi
case "$libc/$target" in
    musl/mips|musl/mipsel) set -- "$@" -DCMAKE_C_FLAGS=-march=mips32r2 ;;
esac
cmake "$@"
cmake --build "$build/native" --parallel "${CMAKE_BUILD_PARALLEL_LEVEL:-4}"
"$strip" "$build/native/oxc.so"
"$readelf" -h "$build/native/oxc.so"
"$readelf" -d "$build/native/oxc.so" > "$build/dynamic-section.txt"
if grep -q TEXTREL "$build/dynamic-section.txt"; then
    printf 'OXC contains text relocations; its Rust archive must be PIC.\n' >&2
    exit 1
fi
"$readelf" --dyn-syms --wide "$build/native/oxc.so" > "$build/dynamic-symbols.txt"
if ! grep -Eq 'GLOBAL[[:space:]]+DEFAULT[[:space:]]+[0-9]+[[:space:]]+tjs_module_info$' "$build/dynamic-symbols.txt"; then
    printf 'OXC does not export its native module entry point.\n' >&2
    exit 1
fi
cp "$build/native/oxc.so" "$stage/ext/oxc.so"
