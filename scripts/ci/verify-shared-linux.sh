#!/bin/sh
set -eu
export LC_ALL=C

libc=${1:?Usage: verify-shared-linux.sh glibc|musl stage [readelf]}
stage=${2:?Missing stage directory}
readelf=${3:-readelf}
root=$(CDPATH= cd -- "$(dirname -- "$0")/../.." && pwd)
case "$libc" in
    musl) sh "$root/scripts/ci/verify-musl.sh" dynamic "$stage/cno" "$readelf" ;;
    glibc)
        headers=$("$readelf" -lW "$stage/cno")
        printf '%s\n' "$headers" | grep -Eq 'Requesting program interpreter: /[^ ]*/ld-linux[^/ ]*\.so\.[0-9]+\]' \
            || { printf 'Expected a dynamic glibc interpreter\n' >&2; exit 1; }
        ;;
    *) printf 'Unsupported libc: %s\n' "$libc" >&2; exit 2 ;;
esac

for path in cno ext/oxc.so; do
    dynamic=$("$readelf" -dW "$stage/$path")
    case "$path" in cno) expected='$ORIGIN/lib' ;; *) expected='$ORIGIN/../lib' ;; esac
    rpath=$(printf '%s\n' "$dynamic" | sed -n 's/.*(RPATH).*\[\([^]]*\)\].*/\1/p')
    if [ "$rpath" != "$expected" ]; then
        printf 'Expected relocatable RPATH %s in %s, got: %s\n' "$expected" "$path" "$rpath" >&2
        exit 1
    fi
done

dynamic=$("$readelf" -dW "$stage/cno")
needed=$(printf '%s\n' "$dynamic" | sed -n 's/.*(NEEDED).*\[\([^]]*\)\].*/\1/p')
# Fail the release if any mandatory external dependency silently falls back
# to an archive. Iconv is part of both libc implementations on these targets.
for library in curl ssl crypto sqlite3 ffi expat z; do
    if ! printf '%s\n' "$needed" | grep -Eq "^lib$library\.so(\.|$)"; then
        printf 'External dependency lib%s must be shared in %s\n' "$library" "$stage/cno" >&2
        exit 1
    fi
done
if printf '%s\n' "$needed" | grep -Eq '^lib(qjs|quickjs|cjs|uv|wamr|vmlib)\.so(\.|$)'; then
    printf 'Bundled circu.js libraries must remain static\n' >&2
    exit 1
fi
test -s "$stage/lib/DEPENDENCIES.txt"
printf '[package] Verified shared external dependencies and relocatable RPATH: %s\n' "$stage"
