#!/bin/sh
set -eu

libc=${1:?Usage: build-linux.sh glibc\|musl target}
target=${2:?Missing target architecture}
case "$libc" in
    glibc)
        export DEBIAN_FRONTEND=noninteractive
        apt-get update
        apt-get install -y --no-install-recommends \
            ca-certificates build-essential cmake ninja-build pkg-config \
            binutils coreutils file libcurl4-openssl-dev libltdl-dev \
            libffi-dev libsqlite3-dev libssl-dev zlib1g-dev libexpat1-dev libbrotli-dev
        archive="cno-linux-$target"
        ;;
    musl)
        # samurai provides /usr/bin/ninja on Alpine. Static curl needs the
        # archives of its complete dependency closure, not only libcurl.a.
        apk add --no-cache ca-certificates build-base cmake samurai pkgconf \
            binutils coreutils file \
            sqlite-dev sqlite-static openssl-dev openssl-libs-static \
            zlib-dev zlib-static expat-dev expat-static libffi-dev libtool \
            curl-dev curl-static brotli-dev brotli-static \
            nghttp2-static zstd-static libpsl-static libidn2-static libunistring-static
        archive="cno-linux-musl-$target"
        ;;
    *) printf 'Unsupported libc: %s\n' "$libc" >&2; exit 1 ;;
esac

case "$target" in
    x86_64) wamr=X86_64 ;;
    i386) wamr=X86_32 ;;
    arm64) wamr=AARCH64 ;;
    armv7) wamr=ARMV7_VFP ;;
    armv6)
        if [ "$libc" = glibc ]; then wamr=ARMV6; else wamr=ARMV6_VFP; fi
        ;;
    *) printf 'Unsupported architecture: %s\n' "$target" >&2; exit 1 ;;
esac

set -- -S . -B build-linux -G Ninja -DCMAKE_BUILD_TYPE=Release \
    -DCNO_RELEASE=ON -DCNO_PREBUILT_BUNDLE="$PWD/dist/cno-cli.js" \
    -DWAMR_BUILD_TARGET="$wamr"
case "$target" in
    i386|armv6|armv7)
        # QuickJS uses 64-bit C11 atomics even on 32-bit CPUs. Put libatomic
        # after all archives, and apply it to both cjsc and the final runtime.
        set -- "$@" -DCMAKE_C_STANDARD_LIBRARIES=-latomic
        ;;
esac
if [ "$target" = armv6 ] && [ "$libc" = glibc ]; then
    set -- "$@" '-DCMAKE_C_FLAGS=-march=armv6 -mfloat-abi=soft' \
        '-DCMAKE_ASM_FLAGS=-march=armv6 -mfloat-abi=soft'
fi
if [ "$libc" = musl ]; then
    set -- "$@" -DCMAKE_EXE_LINKER_FLAGS=-static \
        -DCMAKE_PROJECT_cjs_INCLUDE="$PWD/scripts/ci/static-linux.cmake"
fi
cmake "$@"
cmake --build build-linux --target cno --parallel "${CMAKE_BUILD_PARALLEL_LEVEL:-4}"
strip build-linux/stage/cno
file build-linux/stage/cno
if [ "$libc" = musl ]; then
    # A static artifact must have neither an interpreter nor shared-library
    # dependencies. This catches accidental selection of a system .so.
    readelf -l build-linux/stage/cno > build-linux/program-headers.txt
    readelf -d build-linux/stage/cno > build-linux/dynamic-section.txt
    if grep -q INTERP build-linux/program-headers.txt \
        || grep -q NEEDED build-linux/dynamic-section.txt; then
        printf 'The musl release binary is not fully static\n' >&2
        exit 1
    fi
fi
sh scripts/ci/smoke-core.sh build-linux/stage
mkdir -p artifacts
tar -czf "artifacts/$archive.tar.gz" --exclude='.dlls.stamp' -C build-linux/stage .
