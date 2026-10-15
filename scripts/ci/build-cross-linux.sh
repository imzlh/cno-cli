#!/usr/bin/env bash
set -euo pipefail

target=${1:?usage: build-cross-linux.sh mips|mipsel|mips64|riscv64|armv5}
root=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
cd "$root"
run_tests=${CNO_RUN_TESTS:-true}
case "$run_tests" in
    true|false) ;;
    *) printf 'CNO_RUN_TESTS must be true or false.\n' >&2; exit 2 ;;
esac
case "$target" in
    mips) triple=mips-linux-musl; processor=mips; emulator=qemu-mips; wasm=OFF; wamr=MIPS; big_endian=1 ;;
    mipsel) triple=mipsel-linux-musl; processor=mips; emulator=qemu-mipsel; wasm=ON; wamr=MIPS; big_endian=0 ;;
    mips64) triple=mips64-linux-musl; processor=mips64; emulator=qemu-mips64; wasm=OFF; wamr=MIPS; big_endian=1 ;;
    riscv64) triple=riscv64-linux-musl; processor=riscv64; emulator=qemu-riscv64; wasm=ON; wamr=RISCV64; big_endian=0 ;;
    armv5) triple=armv5l-linux-musleabi; processor=armv5l; emulator=qemu-arm; wasm=ON; wamr=ARMV5; big_endian=0 ;;
    *) printf 'Unsupported cross target: %s\n' "$target" >&2; exit 2 ;;
esac
if [[ $(uname -s) != Linux || $(uname -m) != x86_64 ]]; then
    printf 'musl.cc cross toolchains require an x86_64 Linux build host.\n' >&2
    exit 2
fi
for program in cmake ninja git curl tar sha512sum node timeout "$emulator"; do
    command -v "$program" >/dev/null
done

build="$root/build-cross-$target"
downloads="${RUNNER_TEMP:-$root/.tmp-cross}/cno-toolchains"
archive="$triple-cross.tgz"
mkdir -p "$build/bin" "$downloads"
bash "$root/scripts/ci/download-musl-toolchain.sh" "$archive" "$downloads"
checksum=$(awk -v archive="$archive" '$2 == archive { print $1 }' "$root/scripts/ci/musl-toolchains.sha512")
tar -xzf "$downloads/$archive" -C "$downloads"

export CNO_CROSS_ROOT="$downloads/$triple-cross"
export CNO_CROSS_TRIPLE="$triple"
export CNO_CROSS_PROCESSOR="$processor"
export PATH="$CNO_CROSS_ROOT/bin:$PATH"
export CNO_CROSS_SYSROOT
CNO_CROSS_SYSROOT=$("$triple-gcc" -print-sysroot)
[[ -d "$CNO_CROSS_SYSROOT" && "$CNO_CROSS_SYSROOT" != / ]]
[[ $("$triple-gcc" -dumpmachine) == "$triple" ]]
"$triple-gcc" --version
if [[ $target == mipsel ]]; then
    # WAMR's MIPS native-call assembly requires the o32 hard-float ABI.
    printf '%s\n' \
        '#if !defined(__mips_hard_float) || _MIPS_SIM != _ABIO32' \
        '#error WAMR requires the MIPS o32 hard-float toolchain' \
        '#endif' | "$triple-gcc" -x c -E - >/dev/null
fi

# Use the same vcpkg revision as the manifest, including its port versions.
vcpkg_revision=$(node -e 'console.log(JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"))["builtin-baseline"])' "$root/vcpkg.json")
vcpkg_root="$build/vcpkg"
if [[ ! -d "$vcpkg_root/.git" ]]; then
    git init "$vcpkg_root"
    git -C "$vcpkg_root" remote add origin https://github.com/microsoft/vcpkg.git
fi
git -C "$vcpkg_root" fetch --depth 1 origin "$vcpkg_revision"
git -C "$vcpkg_root" checkout --detach FETCH_HEAD
"$vcpkg_root/bootstrap-vcpkg.sh" -disableMetrics

# QuickJS bytecode stores multibyte values in the target's native byte order.
# Run target cjsc with QEMU on every cross target, including big-endian MIPS.
wrapper="$build/run-cjsc"
printf '#!/usr/bin/env bash\nexec %q -L %q %q "$@"\n' \
    "$(command -v "$emulator")" "$CNO_CROSS_SYSROOT" "$build/bin/cjsc" > "$wrapper"
chmod +x "$wrapper"
cmake -S "$root" -B "$build" -G Ninja \
    -DCMAKE_BUILD_TYPE=Release -DCNO_RELEASE=ON -DBUILD_SHARED_LIBS=OFF \
    -DCMAKE_TOOLCHAIN_FILE="$vcpkg_root/scripts/buildsystems/vcpkg.cmake" \
    -DVCPKG_TARGET_TRIPLET="$target-linux-musl" \
    -DVCPKG_HOST_TRIPLET=x64-linux \
    -DVCPKG_OVERLAY_TRIPLETS="$root/cmake/triplets" \
    -DVCPKG_CHAINLOAD_TOOLCHAIN_FILE="$root/cmake/toolchains/musl-cross.cmake" \
    -DVCPKG_INSTALLED_DIR="$build/vcpkg_installed" \
    -DCMAKE_RUNTIME_OUTPUT_DIRECTORY="$build/bin" \
    -DCNO_PREBUILT_BUNDLE="$root/dist/cno-cli.js" -DCJSC_PATH="$wrapper" \
    -DBUILD_WITH_WASM="$wasm" -DWAMR_BUILD_TARGET="$wamr"
cmake --build "$build" --target cjsc qjsc --parallel "${CMAKE_BUILD_PARALLEL_LEVEL:-4}"

if [[ $big_endian == 1 ]]; then
    # These generated QuickJS builtins are also bytecode. Rebuild them before
    # qjs and cjsc are relinked so no little-endian blobs reach a big-endian CPU.
    (
        cd "$root/circu.js/deps/quickjs"
        for builtin in builtin-array-fromasync builtin-iterator-zip builtin-iterator-zip-keyed; do
            "$emulator" -L "$CNO_CROSS_SYSROOT" "$build/bin/qjsc" \
                -C -ss -o "$builtin.h" "$builtin.js"
        done
    )
    cmake --build "$build" --target cjsc --parallel "${CMAKE_BUILD_PARALLEL_LEVEL:-4}"
fi
cmake --build "$build" --target cno --parallel "${CMAKE_BUILD_PARALLEL_LEVEL:-4}"

binary="$build/stage/cno"
"$triple-strip" "$binary"
"$triple-readelf" -h "$binary"
"$triple-readelf" -l "$binary" > "$build/program-headers.txt"
"$triple-readelf" -d "$binary" > "$build/dynamic-section.txt"
if grep -q INTERP "$build/program-headers.txt" || grep -q NEEDED "$build/dynamic-section.txt"; then
    printf 'Expected a fully static musl executable; found dynamic dependencies.\n' >&2
    exit 1
fi
if [[ $run_tests == true ]]; then
    export CTS_CACHE_DIR="$build/smoke-cache"
    export CTS_EXT_PATH="$build/stage/ext"
    export NO_COLOR=1
    [[ -f "$root/cno/src/node/fs/index.ts" ]]
    smoke() {
        local name=$1 pattern=$2
        shift 2
        timeout --kill-after=10s 180s "$emulator" -L "$CNO_CROSS_SYSROOT" "$binary" "$@" \
            | tee "$build/smoke-$name.log"
        grep -Eq "$pattern" "$build/smoke-$name.log"
    }
    smoke version '^cno [0-9]+\.[0-9]+\.[0-9]+' --version
    smoke setup 'Node polyfills ready at:' setup
    smoke eval '^CNO_CI_EVAL_OK$' eval --ext=js \
        'if (await Promise.resolve(6 * 7) !== 42) throw new Error("evaluation failed"); console.log("CNO_CI_EVAL_OK");'
    smoke typescript '^CNO_CI_TYPESCRIPT_OK$' run --no-oxc --disable-cache scripts/ci/fixtures/typescript.ts
fi

mkdir -p "$root/artifacts"
cat > "$build/stage/BUILD-INFO.txt" <<EOF
Target: linux-musl-$target
Linkage: static musl, including third-party native dependencies
WebAssembly: $wasm
OXC: not included (Sucrase fallback)
Dynamic native library loading is unavailable in this static musl build.
Toolchain: https://musl.cc/$archive
Toolchain mirror: https://github.com/tsl0922/musl-toolchains/releases/download/2021-11-23/$archive
Toolchain SHA512: $checksum
vcpkg revision: $vcpkg_revision
EOF
tar -czf "$root/artifacts/cno-linux-musl-$target.tar.gz" -C "$build/stage" cno BUILD-INFO.txt
