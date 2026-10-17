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
# CNO_STATIC_LINK=false builds a dynamic musl binary for musl-based systems
# (Alpine, OpenWrt) instead of the fully static default.
static_link=${CNO_STATIC_LINK:-true}
case "$static_link" in
    true|false) ;;
    *) printf 'CNO_STATIC_LINK must be true or false.\n' >&2; exit 2 ;;
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

state="$root/build-cross-$target"
if [[ $static_link == true ]]; then
    linkage=static
    build="$state/static"
else
    linkage=dynamic
    build="$state/dynamic"
fi
vcpkg_installed="$state/vcpkg_installed-$linkage"
downloads="${RUNNER_TEMP:-$root/.tmp-cross}/cno-toolchains"
archive="$triple-cross.tgz"
mkdir -p "$build/bin" "$downloads" "$state"
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
export CNO_STATIC_LINK="$static_link"
if [[ $target == mipsel ]]; then
    # WAMR's MIPS native-call assembly requires the o32 hard-float ABI.
    printf '%s\n' \
        '#if !defined(__mips_hard_float) || _MIPS_SIM != _ABIO32' \
        '#error WAMR requires the MIPS o32 hard-float toolchain' \
        '#endif' | "$triple-gcc" -x c -E - >/dev/null
fi
if [[ $target == riscv64 ]]; then
    # The pinned libuv source uses a numeric .insn form rejected by the old
    # binutils bundled with musl.cc. Emit the identical instruction with .word.
    # Accept an already applied patch, but fail visibly if upstream diverges.
    libuv_root="$root/circu.js/deps/libuv"
    libuv_patch="$root/scripts/ci/riscv64-libuv.patch"
    if git -C "$libuv_root" apply --check "$libuv_patch" 2>/dev/null; then
        git -C "$libuv_root" apply "$libuv_patch"
    elif ! git -C "$libuv_root" apply --reverse --check "$libuv_patch" 2>/dev/null; then
        printf 'The RISC-V libuv compatibility patch does not match this checkout.\n' >&2
        exit 1
    fi
fi

# Use the same vcpkg revision as the manifest, including its port versions.
vcpkg_revision=$(node -e 'console.log(JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"))["builtin-baseline"])' "$root/vcpkg.json")
vcpkg_root="$state/vcpkg"
if [[ ! -d "$vcpkg_root/.git" ]]; then
    git init "$vcpkg_root"
    git -C "$vcpkg_root" remote add origin https://github.com/microsoft/vcpkg.git
fi
git -C "$vcpkg_root" fetch --depth 1 origin "$vcpkg_revision"
git -C "$vcpkg_root" checkout --detach FETCH_HEAD
if [[ $run_tests == true ]]; then
    cmake "-DVCPKG_ROOT=$vcpkg_root" -P "$root/tests/ci/cross-link-flags.cmake"
fi
"$vcpkg_root/bootstrap-vcpkg.sh" -disableMetrics

# QuickJS bytecode stores multibyte values in the target's native byte order.
# Run target cjsc with QEMU on every cross target, including big-endian MIPS.
qemu_sysroot="$CNO_CROSS_SYSROOT"
if [[ $static_link == false ]]; then
    qemu_sysroot="$build/qemu-sysroot"
fi
wrapper="$build/run-cjsc"
printf '#!/usr/bin/env bash\nexec %q -L %q %q "$@"\n' \
    "$(command -v "$emulator")" "$qemu_sysroot" "$build/bin/cjsc" > "$wrapper"
chmod +x "$wrapper"
shared_options=()
if [[ $static_link == false ]]; then
    shared_options+=("-DCMAKE_PROJECT_cjs_INCLUDE=$root/scripts/ci/shared-linux.cmake")
    export CNO_OXC_SHARED_RUNTIME=true
else
    export CNO_OXC_SHARED_RUNTIME=false
fi
cmake -S "$root" -B "$build" -G Ninja \
    -DCMAKE_BUILD_TYPE=Release -DCNO_RELEASE=ON -DBUILD_SHARED_LIBS=OFF \
    -DCNO_STATIC_LINK="$static_link" \
    -DCMAKE_TOOLCHAIN_FILE="$vcpkg_root/scripts/buildsystems/vcpkg.cmake" \
    -DVCPKG_TARGET_TRIPLET="$target-linux-musl" \
    -DVCPKG_HOST_TRIPLET=x64-linux \
    -DVCPKG_OVERLAY_TRIPLETS="$root/cmake/triplets" \
    -DVCPKG_CHAINLOAD_TOOLCHAIN_FILE="$root/cmake/toolchains/musl-cross.cmake" \
    -DVCPKG_INSTALLED_DIR="$vcpkg_installed" \
    -DCMAKE_RUNTIME_OUTPUT_DIRECTORY="$build/bin" \
    -DCNO_PREBUILT_BUNDLE="$root/dist/cno-cli.min.js" -DCJSC_PATH="$wrapper" \
    -DBUILD_WITH_WASM="$wasm" -DWAMR_BUILD_TARGET="$wamr" "${shared_options[@]}"
cmake --build "$build" --target cjsc qjsc --parallel "${CMAKE_BUILD_PARALLEL_LEVEL:-4}"

if [[ $static_link == false ]]; then
    sh "$root/scripts/ci/prepare-qemu-sysroot.sh" "$build/bin/qjsc" \
        "$("$triple-gcc" -print-file-name=libc.so)" "$qemu_sysroot" "$triple-readelf"
    # qjsc/cjsc may now use shared libatomic and libgcc. Populate the runtime
    # root before any target bytecode compiler is executed through QEMU.
    bash "$root/scripts/ci/stage-linux-deps.sh" musl "$qemu_sysroot/lib" \
        "$triple-readelf" "$triple-gcc" "$vcpkg_installed/$target-linux-musl/lib" \
        "$build/bin/qjsc" "$build/bin/cjsc"
fi

if [[ $big_endian == 1 ]]; then
    # These generated QuickJS builtins are also bytecode. Rebuild them before
    # qjs and cjsc are relinked so no little-endian blobs reach a big-endian CPU.
    (
        cd "$root/circu.js/deps/quickjs"
        for builtin in builtin-array-fromasync builtin-iterator-zip builtin-iterator-zip-keyed; do
            "$emulator" -L "$qemu_sysroot" "$build/bin/qjsc" \
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
sh "$root/scripts/ci/verify-musl.sh" "$linkage" "$binary" "$triple-readelf"

sh "$root/scripts/ci/build-oxc-linux.sh" musl "$target" "$build/stage" "$state/oxc"
if [[ $static_link == false ]]; then
    bash "$root/scripts/ci/stage-linux-deps.sh" musl "$build/stage/lib" \
        "$triple-readelf" "$triple-gcc" "$vcpkg_installed/$target-linux-musl/lib" \
        "$binary" "$build/stage/ext/oxc.so"
    sh "$root/scripts/ci/verify-shared-linux.sh" musl "$build/stage" "$triple-readelf"
fi
if [[ $run_tests == true ]]; then
    export CTS_CACHE_DIR="$build/smoke-cache"
    export CTS_EXT_PATH="$build/stage/ext"
    export NO_COLOR=1
    [[ -f "$root/cno/src/node/fs/index.ts" ]]
    smoke() {
        local name=$1 pattern=$2
        shift 2
        timeout --kill-after=10s 180s "$emulator" -L "$qemu_sysroot" "$binary" "$@" \
            2>&1 | tee "$build/smoke-$name.log"
        grep -Eq "$pattern" "$build/smoke-$name.log"
    }
    smoke version '^cno [0-9]+\.[0-9]+\.[0-9]+' --version
    smoke setup 'Node polyfills ready at:' setup
    smoke eval '^CNO_CI_EVAL_OK$' eval --ext=js \
        'if (await Promise.resolve(6 * 7) !== 42) throw new Error("evaluation failed"); console.log("CNO_CI_EVAL_OK");'
    smoke typescript '^CNO_CI_TYPESCRIPT_OK$' run --no-oxc --disable-cache scripts/ci/fixtures/typescript.ts
    if [[ $static_link == false ]]; then
        smoke oxc '^CNO_CI_OXC_OK$' run scripts/ci/fixtures/oxc.mjs
        DEBUG=transformer smoke typescript-oxc '^CNO_CI_TYPESCRIPT_OK$' \
            run --disable-cache scripts/ci/fixtures/typescript.ts
        grep -Eq 'oxc( bytes)?: .*[/\\]fixtures[/\\]typescript\.ts' "$build/smoke-typescript-oxc.log"
    fi
fi

mkdir -p "$root/artifacts"
if [[ $static_link == true ]]; then
    archive_name="cno-linux-musl-$target"
    linkage_desc='static musl, including third-party native dependencies'
    dynamic_note='Dynamic native library loading is unavailable in this static musl build; the OXC companion requires a dynamic musl runtime.'
else
    archive_name="cno-linux-musl-dynamic-$target"
    linkage_desc='dynamic musl; external shared libraries bundled in lib/'
    dynamic_note='Targets compatible musl systems and can load native modules. See lib/DEPENDENCIES.txt; remove lib/ to use compatible system packages. The system supplies musl and its loader.'
fi
cat > "$build/stage/BUILD-INFO.txt" <<EOF
Target: ${archive_name#cno-}
Linkage: $linkage_desc
WebAssembly: $wasm
OXC: ext/oxc.so (native musl companion)
$dynamic_note
cno bytes: $(wc -c < "$binary")
OXC bytes: $(wc -c < "$build/stage/ext/oxc.so")
Toolchain: https://musl.cc/$archive
Toolchain mirror: https://github.com/tsl0922/musl-toolchains/releases/download/2021-11-23/$archive
Toolchain SHA512: $checksum
vcpkg revision: $vcpkg_revision
EOF
case "$target" in
    mips)
        printf '%s\n' 'OXC CPU/ABI: MIPS32r2, big-endian o32 hard-float.' >> "$build/stage/BUILD-INFO.txt"
        ;;
    mipsel)
        printf '%s\n' 'CPU/ABI: MIPS32r2, little-endian o32 hard-float (runtime and OXC).' >> "$build/stage/BUILD-INFO.txt"
        ;;
    mips64)
        printf '%s\n' 'OXC CPU/ABI: MIPS64r2, big-endian n64 hard-float. WebAssembly is unsupported on this target.' >> "$build/stage/BUILD-INFO.txt"
        ;;
esac
tar -czf "$root/artifacts/$archive_name.tar.gz" --exclude='.dlls.stamp' -C "$build/stage" .
