#!/bin/bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
HOST_TARGET="${HOST_TARGET:-$(rustc -vV | awk '/^host/ {print $2}')}"
TARGET_DIR="${CARGO_TARGET_DIR:-$REPO_ROOT/target}"
OUT_DIR="$REPO_ROOT/tools/bin"
BIN="$OUT_DIR/wasm-fork-instrument"
STAMP="$BIN.input-hash"

# shellcheck source=fork-instrument-tool-input-hash.sh
source "$REPO_ROOT/scripts/fork-instrument-tool-input-hash.sh"

echo "==> Building wasm-fork-instrument for $HOST_TARGET..."
cargo build \
    --manifest-path "$REPO_ROOT/Cargo.toml" \
    --release \
    -p fork-instrument \
    --target "$HOST_TARGET"

mkdir -p "$OUT_DIR"
BIN_STAGE="$OUT_DIR/.wasm-fork-instrument.$$.tmp"
STAMP_STAGE="$OUT_DIR/.wasm-fork-instrument.$$.input-hash.tmp"
trap 'rm -f "$BIN_STAGE" "$STAMP_STAGE"' EXIT
install -m 0755 \
    "$TARGET_DIR/$HOST_TARGET/release/wasm-fork-instrument" \
    "$BIN_STAGE"

"$BIN_STAGE" --help >/dev/null
fork_instrument_tool_input_hash "$REPO_ROOT" > "$STAMP_STAGE"
mv -f "$BIN_STAGE" "$BIN"
mv -f "$STAMP_STAGE" "$STAMP"
trap - EXIT
echo "==> Installed $BIN"
