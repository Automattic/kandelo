#!/bin/bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
HOST_TARGET="${HOST_TARGET:-$(rustc -vV | awk '/^host/ {print $2}')}"
OUT_DIR="$REPO_ROOT/tools/bin"
BIN="$OUT_DIR/wasm-local-root-spill"

echo "==> Building wasm-local-root-spill for $HOST_TARGET..."
cargo build --release -p wasm-local-root-spill --target "$HOST_TARGET"

mkdir -p "$OUT_DIR"
install -m 0755 \
    "$REPO_ROOT/target/$HOST_TARGET/release/wasm-local-root-spill" \
    "$BIN"

"$BIN" --help >/dev/null
echo "==> Installed $BIN"
