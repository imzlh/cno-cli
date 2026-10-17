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
native_lib_dir=/usr/lib
export CNO_WITH_BROTLI=false

case "$libc" in
    glibc|glibc-minimal)
        export DEBIAN_FRONTEND=noninteractive
        apt-get update
        apt-get install -y --no-install-recommends \
            ca-certificates bash build-essential cmake ninja-build pkg-config \
            binutils coreutils file libltdl-dev \
            libffi-dev libsqlite3-dev libssl-dev zlib1g-dev libexpat1-dev
        if [ "$libc" = glibc ]; then
            apt-get install -y --no-install-recommends libcurl4-openssl-dev libbrotli-dev
            export CNO_WITH_BROTLI=true
        else
            apt-get install -y --no-install-recommends curl \
                libnghttp2-dev libzstd-dev libpsl-dev libidn2-dev
        fi
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
            libffi-dev libtool curl nghttp2-dev zstd-dev libpsl-dev libidn2-dev
        if [ "$libc" = musl ]; then
            # --static pkg-config needs the complete archive dependency closure.
            apk add --no-cache sqlite-static openssl-libs-static zlib-static \
                expat-static nghttp2-static zstd-static \
                libpsl-static libidn2-static libunistring-static
        fi
        archive="cno-linux-$libc-$target"
        oxc_libc=musl
        linkage='dynamic musl; external shared libraries bundled in lib/ (Alpine 3.21 baseline)'
        ;;
esac

# Distro libcurl itself links Brotli. Build only libcurl in a private prefix
# for nonstandard releases so their dependency closure can omit Brotli too.
# Match the source and checksum already pinned by vcpkg for cross builds.
if [ "$CNO_WITH_BROTLI" = false ]; then
    curl_version=8.21.0
    curl_sha512=0ab6c99c3d5b86fb65c526db517c3159b11db2f8d82552d635c4887059c0602288603c93b754ce0ec543ea2f275122ccec2c8dcd866c2611b5b949c728ee72df
    curl_tag="curl-$(printf '%s' "$curl_version" | tr . _)"
    curl_archive="$build/curl-$curl_version.tar.gz"
    native_prefix="$build/native"
    native_lib_dir="$native_prefix/lib"
    mkdir -p "$build"
    curl --fail --location --show-error --connect-timeout 15 --max-time 180 \
        --retry 2 --retry-max-time 360 \
        "https://github.com/curl/curl/archive/$curl_tag.tar.gz" -o "$curl_archive"
    printf '%s  %s\n' "$curl_sha512" "$curl_archive" | sha512sum --check --strict
    tar -xzf "$curl_archive" -C "$build"
    curl_shared=ON
    curl_static=OFF
    if [ "$libc" = musl ]; then curl_shared=OFF; curl_static=ON; fi
    cmake -S "$build/curl-$curl_tag" -B "$build/curl-build" -G Ninja \
        -DCMAKE_BUILD_TYPE=MinSizeRel -DCMAKE_INSTALL_PREFIX="$native_prefix" \
        -DCMAKE_INSTALL_LIBDIR=lib -DBUILD_SHARED_LIBS="$curl_shared" \
        -DBUILD_STATIC_LIBS="$curl_static" -DBUILD_CURL_EXE=OFF -DBUILD_TESTING=OFF \
        -DBUILD_LIBCURL_DOCS=OFF -DBUILD_MISC_DOCS=OFF -DENABLE_CURL_MANUAL=OFF \
        -DCURL_BROTLI=OFF -DCURL_USE_OPENSSL=ON -DCURL_ZLIB=ON -DCURL_ZSTD=ON \
        -DUSE_NGHTTP2=ON -DUSE_LIBIDN2=ON -DCURL_USE_LIBPSL=ON \
        -DCURL_CA_BUNDLE=/etc/ssl/certs/ca-certificates.crt -DCURL_CA_PATH=/etc/ssl/certs \
        -DCMAKE_SHARED_LINKER_FLAGS=-shared-libgcc
    cmake --build "$build/curl-build" --parallel "${CMAKE_BUILD_PARALLEL_LEVEL:-4}"
    cmake --install "$build/curl-build" --strip
    export PKG_CONFIG_PATH="$native_lib_dir/pkgconfig${PKG_CONFIG_PATH:+:$PKG_CONFIG_PATH}"
    curl_link_flags=$(pkg-config --static --libs libcurl)
    if printf '%s\n' "$curl_link_flags" | grep -qi brotli; then
        printf 'The private libcurl still depends on Brotli\n' >&2
        exit 1
    fi
fi

set -- -S . -B "$build" -G Ninja -DCMAKE_BUILD_TYPE=Release \
    -DCNO_RELEASE=ON -DBUILD_SHARED_LIBS=OFF \
    -DCNO_WITH_BROTLI="$CNO_WITH_BROTLI" \
    -DCNO_PREBUILT_BUNDLE="$repository/dist/cno-cli.min.js" \
    -DWAMR_BUILD_TARGET="$wamr"
if [ "$CNO_WITH_BROTLI" = false ]; then
    curl_suffix=.so
    if [ "$libc" = musl ]; then curl_suffix=.a; fi
    set -- "$@" -DCMAKE_PREFIX_PATH="$native_prefix" \
        -DCURL_DIR="$native_lib_dir/cmake/CURL" \
        -DCURL_INCLUDE_DIR="$native_prefix/include" \
        -DCURL_LIBRARY_RELEASE="$native_lib_dir/libcurl$curl_suffix"
fi
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
        bash scripts/ci/linux/stage-deps.sh "$oxc_libc" "$build/stage/lib" readelf cc "$native_lib_dir" \
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
Brotli: $CNO_WITH_BROTLI
WebAssembly: ON ($wamr)
OXC: $oxc_note
Dependencies: $dependency_note
cno bytes: $(wc -c < "$build/stage/cno")
OXC bytes: $(wc -c < "$build/stage/ext/oxc.so")
EOF
mkdir -p artifacts
tar -czf "artifacts/$archive.tar.gz" --exclude='.dlls.stamp' -C "$build/stage" .
