#!/bin/sh
set -eu

linkage=${1:?Usage: verify-musl.sh static\|dynamic binary [readelf]}
binary=${2:?Missing binary}
readelf=${3:-readelf}
case "$linkage" in
    static|dynamic) ;;
    *) printf 'Unsupported linkage: %s\n' "$linkage" >&2; exit 2 ;;
esac

headers=$("$readelf" -lW "$binary")
dynamic=$("$readelf" -dW "$binary")
if [ "$linkage" = static ]; then
    if printf '%s\n' "$headers" | grep -q INTERP \
        || printf '%s\n' "$dynamic" | grep -q NEEDED; then
        printf 'Expected a fully static musl executable: %s\n' "$binary" >&2
        exit 1
    fi
else
    if ! printf '%s\n' "$headers" | grep -Eq 'Requesting program interpreter: /lib/ld-musl-[^/ ]+\.so\.1\]'; then
        printf 'Expected a dynamic musl interpreter: %s\n' "$binary" >&2
        exit 1
    fi
    needed=$(printf '%s\n' "$dynamic" | sed -n 's/.*(NEEDED).*\[\([^]]*\)\].*/\1/p')
    if [ -z "$needed" ]; then
        printf 'Missing musl shared dependency: %s\n' "$binary" >&2
        exit 1
    fi
    for library in $needed; do
        case "$library" in
            libc.so|libc.musl-*.so.1) ;;
            *) printf 'Unexpected shared dependency in %s: %s\n' "$binary" "$library" >&2; exit 1 ;;
        esac
    done
fi
printf '[package] Verified %s musl linkage: %s\n' "$linkage" "$binary"
