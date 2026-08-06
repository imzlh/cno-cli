#!/usr/bin/env bash
# Scratch sweep driver (temporary; delete after the audit).
# Usage: verify-sweep.sh <out-tsv> <dir> [dir...]
set -u

OUT="$1"; shift
LOGDIR=/tmp/verify-logs
mkdir -p "$LOGDIR"

for dir in "$@"; do
    for f in $(ls "$dir"/*.test.ts 2>/dev/null); do
        tag=$(echo "$f" | tr '/' '_')
        line=$(bash tests/_helpers/verify-runner.sh "$f" "$LOGDIR/$tag.log")
        echo "$line" | tee -a "$OUT"
    done
done
