#!/bin/sh
set -eu

binary=${1:?Usage: prepare-qemu-sysroot.sh binary libc.so destination [readelf]}
libc=${2:?Missing target libc.so}
destination=${3:?Missing QEMU sysroot directory}
readelf=${4:-readelf}

# A compiler sysroot is not necessarily a usable runtime root. Relocatable
# musl.cc archives can omit the loader link or retain a link to the build host.
# Use the executable's actual PT_INTERP and GCC's actual libc.so instead.
headers=$(LC_ALL=C "$readelf" -lW "$binary")
interpreter=$(printf '%s\n' "$headers" | sed -n 's/.*Requesting program interpreter: \([^]]*\)\].*/\1/p')
if ! printf '%s\n' "$interpreter" | grep -Eq '^/lib/ld-musl-[[:alnum:]_+.-]+\.so\.1$'; then
    printf 'Expected one musl interpreter in %s, got: %s\n' "$binary" "$interpreter" >&2
    exit 1
fi
case "$interpreter" in
    *'
'*) printf 'Multiple ELF interpreters in %s\n' "$binary" >&2; exit 1 ;;
esac
if [ ! -f "$libc" ]; then
    printf 'Cannot find target musl shared libc: %s\n' "$libc" >&2
    exit 1
fi
LC_ALL=C "$readelf" -h "$libc" >/dev/null

mkdir -p "$destination/lib"
# Use real files, so neither copy depends on absolute symlinks outside this
# runtime root. It is private build state and is not included in release tarballs.
cp -L --remove-destination "$libc" "$destination/lib/libc.so"
cp -L --remove-destination "$libc" "$destination$interpreter"
printf '[qemu] Prepared %s in %s\n' "$interpreter" "$destination"
