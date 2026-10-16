#!/bin/sh
set -eu

libc=${1:?Usage: build-linux.sh glibc\|musl\|musl-dynamic target [true\|false]}
target=${2:?Missing target architecture}
run_tests=${3:-true}
case "$run_tests" in
    true|false) ;;
    *) printf 'Invalid run-tests value: %s (expected true or false)\n' "$run_tests" >&2; exit 2 ;;
esac
case "$libc" in
    glibc|musl|musl-dynamic) ;;
    *) printf 'Unsupported libc: %s\n' "$libc" >&2; exit 2 ;;
esac
case "$target" in
    x86_64) wamr=X86_64 ;;
    i386) wamr=X86_32 ;;
    arm64) wamr=AARCH64 ;;
    armv7) wamr=ARMV7_VFP ;;
    armv6)
        if [ "$libc" = glibc ]; then wamr=ARMV6; else wamr=ARMV6_VFP; fi
        ;;
    *) printf 'Unsupported architecture: %s\n' "$target" >&2; exit 2 ;;
esac
repository=$(CDPATH= cd -- "$(dirname -- "$0")/../.." && pwd)
cd "$repository"
build="$repository/build-linux-$libc-$target"

case "$libc" in
    glibc)
        export DEBIAN_FRONTEND=noninteractive
        apt-get update
        apt-get install -y --no-install-recommends \
            ca-certificates build-essential cmake ninja-build pkg-config \
            binutils coreutils file libcurl4-openssl-dev libltdl-dev \
            libffi-dev libsqlite3-dev libssl-dev zlib1g-dev libexpat1-dev libbrotli-dev
        archive="cno-linux-$target"
        oxc_libc=glibc
        linkage='dynamic glibc and system native libraries (Debian 12 baseline)'
        ;;
    musl|musl-dynamic)
        # --static pkg-config needs the complete archive dependency closure.
        apk add --no-cache ca-certificates build-base cmake samurai pkgconf \
            binutils coreutils file \
            sqlite-dev sqlite-static openssl-dev openssl-libs-static \
            zlib-dev zlib-static expat-dev expat-static libffi-dev libtool \
            curl-dev curl-static brotli-dev brotli-static \
            nghttp2-static zstd-static libpsl-static libidn2-static libunistring-static
        archive="cno-linux-$libc-$target"
        oxc_libc=musl
        linkage='dynamic musl; third-party native libraries and compiler runtimes are static'
        ;;
esac

set -- -S . -B "$build" -G Ninja -DCMAKE_BUILD_TYPE=Release \
    -DCNO_RELEASE=ON -DBUILD_SHARED_LIBS=OFF \
    -DCNO_PREBUILT_BUNDLE="$repository/dist/cno-cli.min.js" \
    -DWAMR_BUILD_TARGET="$wamr"
case "$target" in
    i386|armv6|armv7)
        if [ "$oxc_libc" = musl ]; then
            set -- "$@" '-DCMAKE_C_STANDARD_LIBRARIES=-Wl,--push-state,-Bstatic -latomic -Wl,--pop-state'
        else
            set -- "$@" -DCMAKE_C_STANDARD_LIBRARIES=-latomic
        fi
        ;;
esac
if [ "$target" = armv6 ] && [ "$libc" = glibc ]; then
    set -- "$@" '-DCMAKE_C_FLAGS=-march=armv6 -mfloat-abi=soft' \
        '-DCMAKE_ASM_FLAGS=-march=armv6 -mfloat-abi=soft'
fi
case "$libc" in
    musl|musl-dynamic)
        set -- "$@" "-DCMAKE_PROJECT_cjs_INCLUDE=$repository/scripts/ci/static-linux.cmake"
        if [ "$libc" = musl ]; then
            set -- "$@" -DCMAKE_EXE_LINKER_FLAGS=-static
            linkage='fully static musl, including third-party native libraries'
        else
            set -- "$@" -DCMAKE_EXE_LINKER_FLAGS=-static-libgcc
        fi
        ;;
esac
cmake "$@"
cmake --build "$build" --target cno --parallel "${CMAKE_BUILD_PARALLEL_LEVEL:-4}"
strip "$build/stage/cno"
file "$build/stage/cno"
case "$libc" in
    musl) sh scripts/ci/verify-musl.sh static "$build/stage/cno" ;;
    musl-dynamic) sh scripts/ci/verify-musl.sh dynamic "$build/stage/cno" ;;
esac

# Rust runs on the host; only the C glue and final .so link run in the target
# container. This also supports 32-bit Alpine without a native Rust toolchain.
sh scripts/ci/build-oxc-linux.sh "$oxc_libc" "$target" "$build/stage" "$build/oxc"
if [ "$libc" = musl ]; then
    oxc_note='ext/oxc.so is included for the matching dynamic musl runtime. This static executable uses Sucrase; musl static executables cannot load shared modules.'
else
    oxc_note='ext/oxc.so is loaded at runtime; --no-oxc selects the bundled Sucrase fallback.'
fi
if [ "$run_tests" = true ]; then
    if [ "$libc" = musl ]; then
        sh scripts/ci/smoke-core.sh "$build/stage"
    else
        sh scripts/ci/smoke-core.sh "$build/stage" --with-oxc
    fi
fi
cat > "$build/stage/BUILD-INFO.txt" <<EOF
Target: linux-$libc-$target
Linkage: $linkage
WebAssembly: ON ($wamr)
OXC: $oxc_note
cno bytes: $(wc -c < "$build/stage/cno")
OXC bytes: $(wc -c < "$build/stage/ext/oxc.so")
EOF
mkdir -p artifacts
tar -czf "artifacts/$archive.tar.gz" --exclude='.dlls.stamp' -C "$build/stage" .
