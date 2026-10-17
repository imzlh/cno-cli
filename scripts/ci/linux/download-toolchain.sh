#!/usr/bin/env bash
set -euo pipefail

archive=${1:?usage: download-toolchain.sh archive destination-directory}
downloads=${2:?usage: download-toolchain.sh archive destination-directory}
manifest="$(dirname "${BASH_SOURCE[0]}")/musl-toolchains.sha512"
checksum=$(awk -v archive="$archive" '$2 == archive { print $1 }' "$manifest")
if [[ ! $checksum =~ ^[[:xdigit:]]{128}$ ]]; then
    printf 'Missing or invalid pinned SHA512 for %s\n' "$archive" >&2
    exit 2
fi

mkdir -p "$downloads"
destination="$downloads/$archive"
verify() {
    printf '%s  %s\n' "$checksum" "$1" | sha512sum --check --strict
}
if [[ -f "$destination" ]] && verify "$destination"; then
    printf 'Using verified cached toolchain: %s\n' "$archive"
    exit 0
fi

partial="$destination.part"
trap 'rm -f "$partial"' EXIT
# Both sources publish the exact archives pinned in musl-toolchains.sha512.
sources=(
    https://github.com/tsl0922/musl-toolchains/releases/download/2021-11-23
    https://musl.cc
)
for source in "${sources[@]}"; do
    printf 'Downloading toolchain: %s/%s\n' "$source" "$archive"
    if curl --fail --location --show-error \
        --connect-timeout 15 --max-time 180 --speed-limit 1024 --speed-time 30 \
        --retry 2 --retry-delay 5 --retry-max-time 360 \
        "$source/$archive" -o "$partial" && verify "$partial"; then
        mv -f "$partial" "$destination"
        exit 0
    fi
    printf 'Toolchain source failed download or SHA512 verification: %s\n' "$source" >&2
done
printf 'Unable to download a verified toolchain for %s\n' "$archive" >&2
exit 1
