#!/usr/bin/env bash
# Scratch verification runner (temporary; delete after the audit).
# Runs one test file, polls its log for quiescence, then kills ONLY its own tree.
# Rationale: the runner has an IPC deadlock that keeps every child alive until the
# hard timeout, so waiting for a clean exit costs 300s/file. All `ok`/`fail` lines
# are already flushed by then, so quiescence is a sound completion signal.

set -u

FILE="$1"
LOG="$2"
QUIET_WINDOW="${QUIET_WINDOW:-20}"   # seconds of no log growth => done
HARD_CAP="${HARD_CAP:-300}"          # absolute ceiling per file
CNO="./build/stage/cno.exe"

: > "$LOG"

"$CNO" test "$FILE" --concurrency=1 >>"$LOG" 2>&1 &
BGPID=$!

# Win32 pid of the bash job, needed so taskkill only touches this tree.
WINPID=""
if [ -f "/proc/$BGPID/winpid" ]; then
    WINPID=$(cat "/proc/$BGPID/winpid" 2>/dev/null)
fi

kill_tree() {
    if [ -n "$WINPID" ]; then
        taskkill //T //F //PID "$WINPID" >/dev/null 2>&1
    fi
    kill -9 "$BGPID" >/dev/null 2>&1
    wait "$BGPID" 2>/dev/null
}

last_size=-1
stable_for=0
elapsed=0
status="quiesced"

while :; do
    if ! kill -0 "$BGPID" 2>/dev/null; then
        status="exited-clean"
        break
    fi
    sleep 2
    elapsed=$((elapsed + 2))

    size=$(wc -c < "$LOG" 2>/dev/null || echo 0)
    if [ "$size" = "$last_size" ]; then
        stable_for=$((stable_for + 2))
    else
        stable_for=0
        last_size="$size"
    fi

    # Only start trusting quiescence once the file has produced some result line.
    if [ "$stable_for" -ge "$QUIET_WINDOW" ] && grep -qE '^  (ok|fail|skip) ' "$LOG"; then
        break
    fi
    # No result lines at all: still allow a (longer) bail-out so a genuinely
    # stuck/zero-test file cannot pin the whole sweep.
    if [ "$stable_for" -ge 90 ]; then
        status="quiesced-no-results"
        break
    fi
    if [ "$elapsed" -ge "$HARD_CAP" ]; then
        status="hard-cap"
        break
    fi
done

if [ "$status" != "exited-clean" ]; then
    kill_tree
else
    wait "$BGPID" 2>/dev/null
fi

ok=$(grep -cE '^  ok '    "$LOG" 2>/dev/null); ok=${ok:-0}
fail=$(grep -cE '^  fail ' "$LOG" 2>/dev/null); fail=${fail:-0}
skip=$(grep -cE '^  skip ' "$LOG" 2>/dev/null); skip=${skip:-0}

echo "RESULT|$FILE|ok=$ok|fail=$fail|skip=$skip|status=$status|elapsed=${elapsed}s"

total=$((ok + fail + skip))
if [ "$fail" -gt 0 ] || [ "$total" -eq 0 ] || [ "$status" = "hard-cap" ] || [ "$status" = "quiesced-no-results" ]; then
    exit 1
fi
