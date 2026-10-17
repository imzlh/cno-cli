#!/bin/sh
set -eu

libc=${1:?Usage: build.sh glibc\|glibc-minimal\|musl\|musl-dynamic target [true\|false]}
target=${2:?Missing target architecture}
run_tests=${3:-true}
case "$run_tests" in
    true|false) ;;
    *) printf 'Invalid run-tests value: %s (expected true or false)\n' "$run_tests" >&2; exit 2 ;;
esac
case "$libc" in
    glibc|glibc-minimal|musl|musl-dynamic) ;;
    *) printf 'Unsupported libc: %s\n' "$libc" >&2; exit 2 ;;
esac
case "$target" in
    x86_64) wamr=X86_64 ;;
    i386) wamr=X86_32 ;;
    arm64) wamr=AARCH64 ;;
    armv7) wamr=ARMV7_VFP ;;
    armv6)
        case "$libc" in glibc*) wamr=ARMV6 ;; *) wamr=ARMV6_VFP ;; esac
        ;;
    *) printf 'Unsupported architecture: %s\n' "$target" >&2; exit 2 ;;
esac
repository=$(CDPATH= cd -- "$(dirname -- "$0")/../../.." && pwd)
cd "$repository"
build="$repository/build-linux-$libc-$target"

case "$libc" in
    glibc|glibc-minimal)
        export DEBIAN_FRONTEND=noninteractive
        apt-get update
        apt-get install -y --no-install-recommends \
            ca-certificates bash build-essential cmake ninja-build pkg-config \
            binutils coreutils file libcurl4-openssl-dev libltdl-dev \
            libffi-dev libsqlite3-dev libssl-dev zlib1g-dev libexpat1-dev libbrotli-dev
        archive="cno-linux-$target"
        oxc_libc=glibc
        linkage='dynamic glibc and system native libraries (Debian 12 baseline)'
        if [ "$libc" = glibc-minimal ]; then
            archive="cno-linux-glibc-minimal-$target"
            linkage='dynamic glibc; external shared libraries bundled in lib/ (Debian 12 baseline)'
        fi
        ;;
    musl|musl-dynamic)
        apk add --no-cache ca-certificates bash build-base cmake samurai pkgconf \
            binutils coreutils file sqlite-dev openssl-dev zlib-dev expat-dev \
            libffi-dev libtool curl-dev brotli-dev
        if [ "$libc" = musl ]; then
            # --static pkg-config needs the complete archive dependency closure.
            apk add --no-cache sqlite-static openssl-libs-static zlib-static \
                expat-static curl-static brotli-static nghttp2-static zstd-static \
                libpsl-static libidn2-static libunistring-static
        fi
        archive="cno-linux-$libc-$target"
        oxc_libc=musl
        linkage='dynamic musl; external shared libraries bundled in lib/ (Alpine 3.21 baseline)'
        ;;
esac

set -- -S . -B "$build" -G Ninja -DCMAKE_BUILD_TYPE=Release \
    -DCNO_RELEASE=ON -DBUILD_SHARED_LIBS=OFF \
    -DCNO_PREBUILT_BUNDLE="$repository/dist/cno-cli.min.js" \
    -DWAMR_BUILD_TARGET="$wamr"
case "$target" in
    i386|armv6|armv7)
        if [ "$libc" = musl ]; then
            set -- "$@" '-DCMAKE_C_STANDARD_LIBRARIES=-Wl,--push-state,-Bstatic -latomic -Wl,--pop-state'
        else
            set -- "$@" '-DCMAKE_C_STANDARD_LIBRARIES=-Wl,--push-state,-Bdynamic -l:libatomic.so -Wl,--pop-state'
        fi
        ;;
esac
if [ "$target" = armv6 ] && [ "$oxc_libc" = glibc ]; then
    set -- "$@" '-DCMAKE_C_FLAGS=-march=armv6 -mfloat-abi=soft' \
        '-DCMAKE_ASM_FLAGS=-march=armv6 -mfloat-abi=soft'
fi
case "$libc" in
    musl)
        set -- "$@" "-DCMAKE_PROJECT_cjs_INCLUDE=$repository/cmake/ci/static-linux.cmake"
        set -- "$@" -DCMAKE_EXE_LINKER_FLAGS=-static
        linkage='fully static musl, including third-party native libraries'
        ;;
    musl-dynamic|glibc-minimal)
        set -- "$@" "-DCMAKE_PROJECT_cjs_INCLUDE=$repository/cmake/ci/shared-linux.cmake"
        ;;
esac
cmake "$@"
cmake --build "$build" --target cno --parallel "${CMAKE_BUILD_PARALLEL_LEVEL:-4}"
strip "$build/stage/cno"
file "$build/stage/cno"
if [ "$libc" = musl ]; then
    sh scripts/ci/linux/verify.sh static "$build/stage"
fi

# Rust runs on the host; only the C glue and final .so link run in the target
# container. This also supports 32-bit Alpine without a native Rust toolchain.
case "$libc" in
    musl-dynamic|glibc-minimal)
        export CNO_OXC_SHARED_RUNTIME=true
        dependency_note='See lib/DEPENDENCIES.txt; libc and the loader are supplied by the system.'
        ;;
    glibc)
        export CNO_OXC_SHARED_RUNTIME=false
        dependency_note='External native libraries, libc and the loader are supplied by the system.'
        ;;
    musl)
        export CNO_OXC_SHARED_RUNTIME=false
        dependency_note='The executable includes its native dependencies and needs no system loader.'
        ;;
esac
sh scripts/ci/oxc/build-linux.sh "$oxc_libc" "$target" "$build/stage" "$build/oxc"
case "$libc" in
    musl-dynamic|glibc-minimal)
        bash scripts/ci/linux/stage-deps.sh "$oxc_libc" "$build/stage/lib" readelf cc /usr/lib \
            "$build/stage/cno" "$build/stage/ext/oxc.so"
        sh scripts/ci/linux/verify.sh "$oxc_libc" "$build/stage"
        ;;
esac
if [ "$libc" = musl ]; then
    oxc_note='ext/oxc.so is included for the matching dynamic musl runtime. This static executable uses Sucrase; musl static executables cannot load shared modules.'
else
    oxc_note='ext/oxc.so is loaded at runtime; --no-oxc selects the bundled Sucrase fallback.'
fi
if [ "$run_tests" = true ]; then
    if [ "$libc" = musl ]; then
        sh scripts/ci/linux/smoke.sh "$build/stage"
    else
        sh scripts/ci/linux/smoke.sh "$build/stage" --with-oxc
    fi
fi
cat > "$build/stage/BUILD-INFO.txt" <<EOF
Target: linux-$libc-$target
Linkage: $linkage
WebAssembly: ON ($wamr)
OXC: $oxc_note
Dependencies: $dependency_note
cno bytes: $(wc -c < "$build/stage/cno")
OXC bytes: $(wc -c < "$build/stage/ext/oxc.so")
EOF
mkdir -p artifacts
tar -czf "artifacts/$archive.tar.gz" --exclude='.dlls.stamp' -C "$build/stage" .
