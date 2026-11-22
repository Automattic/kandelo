#!/bin/bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
HOST_TARGET="${HOST_TARGET:-$(rustc -vV | awk '/^host/ {print $2}')}"
TARGET_DIR="${CARGO_TARGET_DIR:-$REPO_ROOT/target}"
OUT_DIR="$REPO_ROOT/tools/bin"
BIN="$OUT_DIR/wasm-memory-instrument"
STAMP="$BIN.input-hash"

# shellcheck source=memory-instrument-tool-input-hash.sh
source "$REPO_ROOT/scripts/memory-instrument-tool-input-hash.sh"

echo "==> Building wasm-memory-instrument for $HOST_TARGET..."
cargo build \
    --manifest-path "$REPO_ROOT/Cargo.toml" \
    --profile instrumenter \
    -p memory-instrument \
    --target "$HOST_TARGET"

mkdir -p "$OUT_DIR"
BIN_STAGE="$OUT_DIR/.wasm-memory-instrument.$$.tmp"
STAMP_STAGE="$OUT_DIR/.wasm-memory-instrument.$$.input-hash.tmp"
trap 'rm -f "$BIN_STAGE" "$STAMP_STAGE"' EXIT
install -m 0755 \
    "$TARGET_DIR/$HOST_TARGET/instrumenter/wasm-memory-instrument" \
    "$BIN_STAGE"

"$BIN_STAGE" --help >/dev/null
memory_instrument_tool_input_hash "$REPO_ROOT" > "$STAMP_STAGE"
mv -f "$BIN_STAGE" "$BIN"
mv -f "$STAMP_STAGE" "$STAMP"
trap - EXIT
echo "==> Installed $BIN"
