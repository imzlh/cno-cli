#!/usr/bin/env bash
# Sync workspace http/ into the @cnojs/http npm store of a CTS cache dir.
#
# Why this exists: `cno setup` already syncs http/ (installLocalHttpToStore in
# src/commands/setup.ts), but it also re-copies all of cno/src/node, which is slow and
# picks up whatever other agents have mid-edit in the shared tree. When you are only
# iterating on http/src/**, this refreshes just that package.
#
# You often do not need it at all: node_modules/@cnojs/http is a symlink to http/, so a
# script run from the repo root sees edits immediately with no rebuild and no setup.
# The store copy is what importers resolving through the cache use, and those two can
# drift. Run this to force them back into agreement.
#
# Usage: CTS_CACHE_DIR=/path/to/cache scripts/sync-http-store.sh
set -euo pipefail

: "${CTS_CACHE_DIR:?set CTS_CACHE_DIR to your own cache dir}"

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
src="$repo_root/http"
version="$(grep -m1 '"version"' "$src/package.json" | sed 's/.*"version"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/')"
dst="$CTS_CACHE_DIR/npm/@cnojs/http@$version"

if [ ! -f "$src/package.json" ]; then
    echo "no package.json under $src" >&2
    exit 1
fi

mkdir -p "$dst"
# Mirror `files` from http/package.json: src, ext-h2, utils.
for dir in src ext-h2 utils; do
    [ -d "$src/$dir" ] || continue
    mkdir -p "$dst/$dir"
    cp -R "$src/$dir/." "$dst/$dir/"
done
cp "$src/package.json" "$dst/package.json"

# Stale bytecode beside the store tree would shadow the sources just copied.
jsc_removed=$(find "$dst" -name '*.jsc' -type f -print -delete 2>/dev/null | wc -l | tr -d ' ')

echo "@cnojs/http@$version -> $dst (cleared ${jsc_removed} .jsc)"
