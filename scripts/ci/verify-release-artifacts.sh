#!/bin/sh
set -eu

cd "${1:?Usage: verify-release-artifacts.sh artifact-directory}"
expected=0
check_archive() {
    archive=$1
    runtime=$2
    extension=$3
    test -s "$archive" || { printf 'Missing release archive: %s\n' "$archive" >&2; exit 1; }
    case "$archive" in
        *.tar.gz) entries=$(tar -tzf "$archive") ;;
        *.zip) entries=$(unzip -Z1 "$archive") ;;
    esac
    for path in "$runtime" "$extension"; do
        if ! printf '%s\n' "$entries" | sed 's|^\./||' | grep -Fx "$path" >/dev/null; then
            printf '%s is missing %s\n' "$archive" "$path" >&2
            exit 1
        fi
    done
    expected=$((expected + 1))
}

for target in x86_64 i386 arm64 armv7 armv6; do
    check_archive "cno-linux-$target.tar.gz" cno ext/oxc.so
done
for target in x86_64 i386 arm64 armv7 armv6 mips mipsel mips64 riscv64 armv5; do
    check_archive "cno-linux-musl-$target.tar.gz" cno ext/oxc.so
    check_archive "cno-linux-musl-dynamic-$target.tar.gz" cno ext/oxc.so
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
printf '[package] Verified all %s release archives and their OXC extensions\n' "$expected"
