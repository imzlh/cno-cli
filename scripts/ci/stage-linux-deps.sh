#!/usr/bin/env bash
set -euo pipefail
export LC_ALL=C

# Read ELF metadata without executing target binaries or consulting host ldd.
# GCC resolves compiler runtimes/multiarch paths; SEARCH_DIR supplies vcpkg or
# native package libraries. The same helper can populate QEMU's private /lib.
libc=${1:?Usage: stage-linux-deps.sh glibc|musl destination readelf cc search-dir binary...}
destination=${2:?Missing destination}
readelf=${3:?Missing target readelf}
cc=${4:?Missing target compiler}
search_dir=${5:?Missing library search directory}
shift 5
[[ $# -gt 0 ]] || { printf 'At least one ELF input is required.\n' >&2; exit 2; }
case "$libc" in
    glibc|musl) ;;
    *) printf 'Unsupported libc: %s\n' "$libc" >&2; exit 2 ;;
esac

fail() { printf '%s\n' "$*" >&2; exit 1; }
elf_identity() {
    local headers identity
    headers=$("$readelf" -hW "$1") || return 1
    identity=$(printf '%s\n' "$headers" | sed -n \
        -e 's/^[[:space:]]*Class:[[:space:]]*/Class: /p' \
        -e 's/^[[:space:]]*Data:[[:space:]]*/Data: /p' \
        -e 's/^[[:space:]]*Machine:[[:space:]]*/Machine: /p')
    [[ $(printf '%s\n' "$identity" | wc -l) -eq 3 ]] || return 1
    printf '%s\n' "$identity"
}

expected=$(elf_identity "$1") || fail "Cannot identify target ELF: $1"
queue=("$@")
declare -A seen=() bundled=() system=()
mkdir -p "$destination"
for ((index=0; index<${#queue[@]}; index++)); do
    binary=${queue[index]}
    identity=$(elf_identity "$binary") || fail "Not an ELF library: $binary"
    [[ "$identity" == "$expected" ]] || fail "ELF architecture mismatch: $binary"
    dynamic=$("$readelf" -dW "$binary") || fail "Cannot read dependencies: $binary"
    needed=$(printf '%s\n' "$dynamic" | sed -n 's/.*(NEEDED).*\[\([^]]*\)\].*/\1/p')
    while IFS= read -r soname; do
        [[ -n "$soname" ]] || continue
        # SONAMEs are filenames, never paths; reject unexpected linker inputs.
        [[ "$soname" != */* && "$soname" != .* && "$soname" != *[!a-zA-Z0-9_.+-]* ]] \
            || fail "Invalid dependency name in $binary: $soname"
        [[ -z ${seen[$soname]:-} ]] || continue
        seen[$soname]=1
        case "$libc/$soname" in
            musl/libc.so|musl/libc.musl-*.so.1|musl/ld-musl-*.so.1)
                system[$soname]=1; continue ;;
            glibc/libc.so.6|glibc/libm.so.6|glibc/libmvec.so.1|glibc/libpthread.so.0|\
            glibc/librt.so.1|glibc/libdl.so.2|glibc/libutil.so.1|glibc/libresolv.so.2|\
            glibc/libanl.so.1|glibc/libBrokenLocale.so.1|glibc/libthread_db.so.1|\
            glibc/libnss_compat.so.2|glibc/libnss_dns.so.2|glibc/libnss_files.so.2|\
            glibc/libnss_hesiod.so.2|glibc/ld-linux*.so.*|glibc/ld64.so.*)
                system[$soname]=1; continue ;;
            musl/libc.so.6|musl/ld-linux*.so.*|glibc/libc.so|glibc/libc.musl-*.so.1|glibc/ld-musl-*.so.1)
                fail "Foreign libc dependency in $binary: $soname" ;;
        esac
        source="$search_dir/$soname"
        if [[ ! -f "$source" ]]; then
            source=$("$cc" "-print-file-name=$soname")
            [[ "$source" != "$soname" && -f "$source" ]] \
                || fail "Cannot resolve $soname required by $binary (search: $search_dir, $cc)"
        fi
        identity=$(elf_identity "$source") || fail "Not an ELF library: $source"
        [[ "$identity" == "$expected" ]] || fail "ELF architecture mismatch for $soname: $source"
        # Store real files under their SONAME so symlinks outside the package
        # cannot break a relocated archive. Refresh safely on repeated builds.
        cp -L --remove-destination -- "$source" "$destination/$soname"
        bundled[$soname]=1
        queue+=("$destination/$soname")
    done <<< "$needed"
done

{
    printf 'Platform libc: %s (libc and ELF loader are provided by the operating system).\n' "$libc"
    printf '%s\n' \
        'The executable and ext/oxc.so load bundled external libraries from lib/.' \
        'You may remove lib/ and install system packages providing the same SONAMEs and compatible symbol versions/CPU ABI.' \
        'Libraries bundled from the build environment (including transitive dependencies):'
    if ((${#bundled[@]})); then printf '  %s\n' "${!bundled[@]}" | sort; fi
    printf 'Required system libc libraries:\n'
    if ((${#system[@]})); then printf '  %s\n' "${!system[@]}" | sort; fi
} > "$destination/DEPENDENCIES.txt"
printf '[package] Staged %s shared libraries in %s\n' "${#bundled[@]}" "$destination"
