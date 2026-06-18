#!/usr/bin/env sh
# Build cno + ext-oxc and collect everything into dist/exe/
set -eu

BUILD_DIR="build"
OXC_BUILD_DIR="ext-oxc/build"
DIST_DIR="dist/exe"

# ── 1. Main project ───────────────────────────────────────────────────────────
cmake -S . -B "$BUILD_DIR" -DCMAKE_BUILD_TYPE=Release
cmake --build "$BUILD_DIR" --config Release --parallel

# ── 2. ext-oxc ────────────────────────────────────────────────────────────────
cmake -S ext-oxc -B "$OXC_BUILD_DIR" -DCMAKE_BUILD_TYPE=Release \
  -DCNO_SRC_DIR="$(pwd)/circu.js/src" \
  -DQUICKJS_DIR="$(pwd)/circu.js/deps/quickjs"
cmake --build "$OXC_BUILD_DIR" --config Release --parallel

# ── 3. Collect into dist/exe/ ─────────────────────────────────────────────────
mkdir -p "$DIST_DIR/ext"

cp "$BUILD_DIR/stage/cno"        "$DIST_DIR/cno"
cp "$OXC_BUILD_DIR/swc.so"       "$DIST_DIR/ext/swc.so" 2>/dev/null || \
cp "$OXC_BUILD_DIR/swc.dylib"    "$DIST_DIR/ext/swc.dylib" 2>/dev/null || true

echo ""
echo "dist/exe/ contents:"
ls -lh "$DIST_DIR" "$DIST_DIR/ext"
