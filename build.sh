#!/usr/bin/env sh
# Build cno + ext-oxc and collect everything into dist/exe/
# ext-oxc is OPTIONAL: it needs a Rust toolchain. If cargo is missing the
# ext-oxc step is skipped with a notice and the build still succeeds.
set -eu

# Resolve paths relative to this script, rather than the caller's cwd.  This
# keeps `./build.sh` and `path/to/build.sh` equivalent (CI often invokes the
# latter from a separate staging directory).
ROOT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
cd "$ROOT_DIR"

BUILD_DIR="build"
OXC_BUILD_DIR="ext-oxc/build"
DIST_DIR="dist/exe"

# ── 1. Main project ───────────────────────────────────────────────────────────
cmake -S . -B "$BUILD_DIR" -DCMAKE_BUILD_TYPE=Release -DCNO_RELEASE=ON
cmake --build "$BUILD_DIR" --config Release --parallel

# ── 2. ext-oxc (optional) ─────────────────────────────────────────────────────
# Rust is not part of the required toolchain — probe before doing anything.
OXC_BUILT=0
if ! command -v cargo >/dev/null 2>&1; then
    echo "note: cargo not found — skipping ext-oxc (optional native TS transform)."
    echo "      CTS falls back to the bundled Sucrase transformer."
    echo "      Install a Rust toolchain and re-run to build it."
elif cmake -S ext-oxc -B "$OXC_BUILD_DIR" -DCMAKE_BUILD_TYPE=Release \
       -DCJS_DIR="$(pwd)/circu.js" &&
     cmake --build "$OXC_BUILD_DIR" --config Release --parallel; then
    OXC_BUILT=1
else
    echo "warning: ext-oxc build failed — continuing without it (Sucrase fallback)." >&2
fi

# ── 3. Collect into dist/exe/ ─────────────────────────────────────────────────
mkdir -p "$DIST_DIR/ext"

cp "$BUILD_DIR/stage/cno"        "$DIST_DIR/cno"
if [ "$OXC_BUILT" = 1 ]; then
    cp "$OXC_BUILD_DIR/oxc.so"    "$DIST_DIR/ext/oxc.so" 2>/dev/null || \
    cp "$OXC_BUILD_DIR/oxc.dylib" "$DIST_DIR/ext/oxc.dylib" 2>/dev/null || \
    echo "warning: no oxc.so/oxc.dylib in $OXC_BUILD_DIR" >&2
fi

echo ""
echo "dist/exe/ contents:"
ls -lh "$DIST_DIR" "$DIST_DIR/ext"
