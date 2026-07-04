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
  -DCJS_DIR="$(pwd)/circu.js"
cmake --build "$OXC_BUILD_DIR" --config Release --parallel

# ── 3. Collect into dist/exe/ ─────────────────────────────────────────────────
mkdir -p "$DIST_DIR/ext"

cp "$BUILD_DIR/stage/cno"        "$DIST_DIR/cno"
cp "$OXC_BUILD_DIR/oxc.so"       "$DIST_DIR/ext/oxc.so" 2>/dev/null || \
cp "$OXC_BUILD_DIR/oxc.dylib"    "$DIST_DIR/ext/oxc.dylib" 2>/dev/null || true

echo ""
echo "dist/exe/ contents:"
ls -lh "$DIST_DIR" "$DIST_DIR/ext"
