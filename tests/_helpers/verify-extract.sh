#!/usr/bin/env bash
# Scratch failure extractor (temporary; delete after the audit).
cd /tmp/verify-logs || exit 1
for f in "$@"; do
    log="$(echo "$f" | tr '/' '_').log"
    [ -f "$log" ] || continue
    n=$(grep -cE '^  fail ' "$log" 2>/dev/null); n=${n:-0}
    [ "$n" = "0" ] && continue
    echo "################ $f  ($n fail)"
    sed -n '/^Failed tests:/,$p' "$log" | grep -vE '^\s*$' | head -70
    echo
done
