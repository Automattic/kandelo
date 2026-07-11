#!/bin/bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
HOST_TARGET="${HOST_TARGET:-$(rustc -vV | awk '/^host/ {print $2}')}"
OUT_DIR="$REPO_ROOT/tools/bin"
BIN="$OUT_DIR/wasm-fork-instrument"

echo "==> Building wasm-fork-instrument for $HOST_TARGET..."
cargo build \
    --manifest-path "$REPO_ROOT/Cargo.toml" \
    --release \
    -p fork-instrument \
    --target "$HOST_TARGET"

mkdir -p "$OUT_DIR"
install -m 0755 \
    "$REPO_ROOT/target/$HOST_TARGET/release/wasm-fork-instrument" \
    "$BIN"

"$BIN" --help >/dev/null
echo "==> Installed $BIN"
