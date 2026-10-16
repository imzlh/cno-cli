#!/bin/sh
set -eu

repository=$(CDPATH= cd -- "$(dirname -- "$0")/../.." && pwd)
case "${1:?Usage: smoke-core.sh stage-directory}" in
    /*) stage=$1 ;;
    *) stage="$repository/$1" ;;
esac
binary="$stage/cno"
with_oxc=false
case "${2:-}" in
    '') ;;
    --with-oxc) with_oxc=true; test -f "$stage/ext/oxc.so" ;;
    *) printf 'Usage: smoke-core.sh stage-directory [--with-oxc]\n' >&2; exit 2 ;;
esac
test -x "$binary"
test -f "$repository/cno/src/node/fs/index.ts"
cd "$repository"

: "${CTS_CACHE_DIR:=$(mktemp -d /tmp/cno-ci-smoke.XXXXXX)}"
export CTS_CACHE_DIR
CTS_EXT_PATH="$stage/ext"
export CTS_EXT_PATH
mkdir -p "$CTS_CACHE_DIR"
log="$CTS_CACHE_DIR/smoke-output.log"

run_check() {
    label=$1
    expected=$2
    shift 2
    printf '\n[smoke] %s\n' "$label"
    if timeout --signal=KILL 300 "$binary" "$@" > "$log" 2>&1; then
        cat "$log"
    else
        status=$?
        cat "$log"
        printf '%s exited with status %s\n' "$label" "$status" >&2
        exit "$status"
    fi
    if ! grep -F "$expected" "$log" > /dev/null; then
        printf '%s did not produce expected output: %s\n' "$label" "$expected" >&2
        exit 1
    fi
}

run_check version 'cno ' --version
run_check 'install local polyfills' 'Node polyfills ready at:' setup
run_check 'JavaScript evaluation' CNO_CI_EVAL_OK eval --ext=js \
    'if (await Promise.resolve(6 * 7) !== 42) throw new Error("evaluation failed"); console.log("CNO_CI_EVAL_OK");'
if [ "$with_oxc" = true ]; then
    run_check 'load and call native OXC' CNO_CI_OXC_OK run scripts/ci/fixtures/oxc.mjs
fi
DEBUG=transformer run_check 'TypeScript automatic transformer' CNO_CI_TYPESCRIPT_OK run --disable-cache \
    scripts/ci/fixtures/typescript.ts
if [ "$with_oxc" = true ] && ! grep -Eq 'oxc( bytes)?: .*fixtures/typescript\.ts' "$log"; then
    printf 'The TypeScript fixture did not use native OXC\n' >&2
    exit 1
fi
DEBUG=transformer run_check 'TypeScript with explicit fallback' CNO_CI_TYPESCRIPT_OK run --no-oxc --disable-cache \
    scripts/ci/fixtures/typescript.ts
if grep -Eq 'oxc( bytes)?: .*fixtures/typescript\.ts' "$log"; then
    printf 'The --no-oxc fixture unexpectedly used native OXC\n' >&2
    exit 1
fi
run_check 'CLI flag regression tests' '1/1' test --no-oxc tests/cts/cli-flag-consumers.test.ts
printf '\n[smoke] All core runtime checks passed.\n'
