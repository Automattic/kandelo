#!/usr/bin/env bash
# Prepare the trusted host-side package materializer and every locked crate
# its later offline metadata reads can require.
set -euo pipefail

HOST_TARGET=""

while [ "$#" -gt 0 ]; do
  case "$1" in
    --host-target) HOST_TARGET="${2:-}"; shift 2 ;;
    *)
      echo "prepare-homebrew-package-materializer: unknown flag $1" >&2
      exit 2
      ;;
  esac
done

if ! [[ "$HOST_TARGET" =~ ^[A-Za-z0-9_]+(-[A-Za-z0-9_]+){2,3}$ ]]; then
  echo "prepare-homebrew-package-materializer: a valid Rust host target is required" >&2
  exit 2
fi

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
AUTHORITY_ROOT="$(git -C "$SCRIPT_DIR" rev-parse --show-toplevel)"
AUTHORITY_MANIFEST="$AUTHORITY_ROOT/Cargo.toml"
AUTHORITY_LOCK="$AUTHORITY_ROOT/Cargo.lock"
TARGET_DIR="$AUTHORITY_ROOT/target"
if [ ! -f "$AUTHORITY_MANIFEST" ] || [ -L "$AUTHORITY_MANIFEST" ] ||
   [ ! -f "$AUTHORITY_LOCK" ] || [ -L "$AUTHORITY_LOCK" ]; then
  echo "prepare-homebrew-package-materializer: authority Cargo workspace is incomplete" >&2
  exit 2
fi

(
  cd "$AUTHORITY_ROOT"

  # WHY: building xtask can populate only its own dependency subset, while
  # the later inert-source `cargo metadata --offline` scan may require any
  # checksum-bound host crate in this exact lockfile. Fetch the complete host
  # projection from trusted authority before entering that offline boundary.
  cargo fetch --locked \
    --manifest-path "$AUTHORITY_MANIFEST" \
    --target "$HOST_TARGET"
  cargo build --locked --release -p xtask \
    --manifest-path "$AUTHORITY_MANIFEST" \
    --target "$HOST_TARGET" \
    --target-dir "$TARGET_DIR" \
    --quiet
)

XTASK="$TARGET_DIR/$HOST_TARGET/release/xtask"
if [ ! -f "$XTASK" ] || [ -L "$XTASK" ] || [ ! -x "$XTASK" ]; then
  echo "prepare-homebrew-package-materializer: Cargo did not build an exact xtask" >&2
  exit 1
fi

echo "prepare-homebrew-package-materializer: prepared locked host Cargo state"
