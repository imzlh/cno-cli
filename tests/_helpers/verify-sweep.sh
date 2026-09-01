#!/usr/bin/env bash
# Scratch sweep driver (temporary; delete after the audit).
# Usage: verify-sweep.sh <out-tsv> <dir> [dir...]
set -u

OUT="$1"; shift
LOGDIR=/tmp/verify-logs
mkdir -p "$LOGDIR"
result=0

for dir in "$@"; do
    for f in "$dir"/*.test.ts; do
        [ -e "$f" ] || continue
        tag=$(printf '%s' "$f" | tr '/' '_')
        if line=$(bash tests/_helpers/verify-runner.sh "$f" "$LOGDIR/$tag.log"); then
            :
        else
            result=1
        fi
        echo "$line" | tee -a "$OUT"
    done
done

exit "$result"
