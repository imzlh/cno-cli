#!/bin/sh
set -eu
LC_ALL=C
export LC_ALL

# Link targets can also live in local ZIP headers, outside zipinfo output.
check_zip_local_headers() {
    # PKWARE Unix variable data carries links/devices; ASi Unix can override type.
    if ! printf '%s\n' "$metadata" | awk '
        /subfield with ID 0x000d / {
            size = $0;
            sub(/^.* and /, "", size);
            if (size + 0 > 12)
                bad = 1;
        }
        /subfield with ID 0x756e / { bad = 1 }
        END { exit bad ? 1 : 0 }
    '; then
        return 1
    fi
    offsets=$(printf '%s\n' "$metadata" | awk '/^  offset of local header from start of archive:/ { print $NF }')
    [ -n "$offsets" ] || return 1
    for offset in $offsets; do
        header=$(dd if="$archive" bs=1 skip="$offset" count=30 2>/dev/null | od -An -v -tu1)
        lengths=$(printf '%s\n' "$header" | awk '
            { for (i = 1; i <= NF; i++) bytes[++n] = $i }
            END {
                if (n != 30 || bytes[1] != 80 || bytes[2] != 75 || bytes[3] != 3 || bytes[4] != 4)
                    exit 1;
                print bytes[27] + 256 * bytes[28], bytes[29] + 256 * bytes[30];
            }
        ') || return 1
        # shellcheck disable=SC2086
        set -- $lengths
        extra_offset=$((offset + 30 + $1))
        extra_size=$2
        extra=$(dd if="$archive" bs=1 skip="$extra_offset" count="$extra_size" 2>/dev/null | od -An -v -tu1)
        printf '%s\n' "$extra" | awk -v size="$extra_size" '
            { for (i = 1; i <= NF; i++) bytes[++n] = $i }
            END {
                if (n != size)
                    exit 1;
                for (i = 1; i <= n; i += 4 + field_length) {
                    if (i + 3 > n)
                        exit 1;
                    id = bytes[i] + 256 * bytes[i + 1];
                    field_length = bytes[i + 2] + 256 * bytes[i + 3];
                    if (i + 3 + field_length > n ||
                        (id == 13 && field_length > 12) || id == 30062)
                        exit 1;
                }
            }
        ' || return 1
    done
}

cd "${1:?Usage: verify-release-artifacts.sh artifact-directory}"
expected=0
check_archive() {
    archive=$1
    runtime=$2
    extension=$3
    shared=${4:-false}
    test -s "$archive" || { printf 'Missing release archive: %s\n' "$archive" >&2; exit 1; }
    case "$archive" in
        *.tar.gz) entries=$(tar -tzf "$archive") ;;
        *.zip) entries=$(unzip -Z1 "$archive") ;;
    esac
    if printf '%s\n' "$entries" | sed 's|^\./||' | grep -Eq '(^/|(^|/)\.\.($|/))'; then
        printf '%s contains an unsafe archive path\n' "$archive" >&2
        exit 1
    fi
    for path in "$runtime" "$extension"; do
        if ! printf '%s\n' "$entries" | sed 's|^\./||' | grep -Fx "$path" >/dev/null; then
            printf '%s is missing %s\n' "$archive" "$path" >&2
            exit 1
        fi
    done
    case "$archive" in
        *.tar.gz)
            listing=$(tar --numeric-owner --full-time --quoting-style=escape -tvzf "$archive")
            fields=5
            executable=true
            ;;
        *.zip)
            listing=$(unzip -Z -l-h-t-z "$archive")
            fields=9
            executable=false
            metadata=$(unzip -Z -v "$archive")
            if ! check_zip_local_headers; then
                printf '%s contains unsupported ZIP link metadata or an invalid local header\n' "$archive" >&2
                exit 1
            fi
            ;;
    esac
    if printf '%s\n' "$listing" | awk -v runtime="$runtime" -v extension="$extension" \
            -v fields="$fields" -v executable="$executable" '
        {
            type = substr($1, 1, 1);
            if (type != "d" && type != "-")
                bad_type = 1;
            path = $0;
            for (i = 0; i < fields; i++)
                sub(/^[^[:space:]]+[[:space:]]+/, "", path);
            gsub(/\/+/, "/", path);
            while (sub(/^\.\//, "", path)) {}
            while (gsub(/\/\.\//, "/", path)) {}
            sub(/\/$/, "", path);
            if (path == runtime) {
                runtime_count++;
                if (type != "-" || (executable == "true" && substr($1, 4, 1) != "x"))
                    runtime_bad = 1;
            }
            if (path == extension) {
                extension_count++;
                if (type != "-")
                    extension_bad = 1;
            }
        }
        END {
            if (bad_type)
                exit 3;
            if (runtime_count != 1 || runtime_bad)
                exit 1;
            if (extension_count != 1 || extension_bad)
                exit 2;
        }
    '; then
        :
    else
        status=$?
        case "$status" in
            1)
                if [ "$executable" = true ]; then
                    printf '%s must contain executable regular file %s exactly once\n' "$archive" "$runtime" >&2
                else
                    printf '%s must contain regular file %s exactly once\n' "$archive" "$runtime" >&2
                fi ;;
            2) printf '%s must contain regular file %s exactly once\n' "$archive" "$extension" >&2 ;;
            *) printf '%s contains an unsupported non-regular archive member\n' "$archive" >&2 ;;
        esac
        exit 1
    fi
    if printf '%s\n' "$entries" | sed 's|^\./||' | grep -E '^lib/cno/bun(/|$)' >/dev/null; then
        printf '%s contains a stale Bun payload under lib/cno/bun\n' "$archive" >&2
        exit 1
    fi
    if [ "$shared" = true ] && ! printf '%s\n' "$entries" | sed 's|^\./||' | \
            grep -E '^lib/[^/]+\.so(\.[^/]+)*$' >/dev/null; then
        printf '%s is missing bundled shared dependencies in lib/\n' "$archive" >&2
        exit 1
    fi
    expected=$((expected + 1))
}

for target in x86_64 i386 arm64 armv7 armv6; do
    check_archive "cno-linux-$target.tar.gz" cno ext/oxc.so
    check_archive "cno-linux-minimal-$target.tar.gz" cno ext/oxc.so true
done
for target in x86_64 i386 arm64 armv7 armv6 mips mipsel mips64 riscv64 armv5; do
    check_archive "cno-linux-musl-$target.tar.gz" cno ext/oxc.so
    check_archive "cno-linux-musl-dynamic-$target.tar.gz" cno ext/oxc.so true
done
for target in x86_64 arm64; do
    check_archive "cno-macos-$target.tar.gz" cno ext/oxc.dylib
done
for target in x64 arm64; do
    check_archive "cno-windows-$target.zip" cno.exe ext/oxc.dll
done
set -- ./*.tar.gz ./*.zip
if [ "$#" -ne "$expected" ]; then
    printf 'Expected %s release archives, found %s\n' "$expected" "$#" >&2
    exit 1
fi
printf '[package] Verified all %s release archives, OXC extensions and shared dependency bundles\n' "$expected"
