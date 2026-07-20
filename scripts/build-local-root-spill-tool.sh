#!/bin/bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
HOST_TARGET="${HOST_TARGET:-$(rustc -vV | awk '/^host/ {print $2}')}"
TARGET_DIR="${CARGO_TARGET_DIR:-$REPO_ROOT/target}"
OUT_DIR="${WASM_POSIX_LOCAL_ROOT_SPILL_OUT_DIR:-$REPO_ROOT/tools/bin}"
BIN="$OUT_DIR/wasm-local-root-spill"

echo "==> Building wasm-local-root-spill for $HOST_TARGET..."
env -u CC -u CXX -u AR -u RANLIB \
    -u CFLAGS -u CXXFLAGS -u CPPFLAGS -u LDFLAGS \
    CARGO_TARGET_DIR="$TARGET_DIR" cargo build \
    --manifest-path "$REPO_ROOT/Cargo.toml" \
    --locked \
    --release \
    -p wasm-local-root-spill \
    --target "$HOST_TARGET"

mkdir -p "$OUT_DIR"
install -m 0755 \
    "$TARGET_DIR/$HOST_TARGET/release/wasm-local-root-spill" \
    "$BIN"

"$BIN" --help >/dev/null
echo "==> Installed $BIN"
