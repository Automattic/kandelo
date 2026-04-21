#!/usr/bin/env bash
#
# Build nethack.zip for the browser shell demo.
#
# Packages nethack.wasm plus the runtime tree (nhdat, symbols, license)
# into a single zip archive. The shell VFS image registers this as a
# lazy archive with mount prefix /usr/, so entries become /usr/bin/nethack
# and /usr/share/nethack/…. On first exec of nethack, the whole archive
# is fetched and unpacked in one go.
#
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
BROWSER_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
REPO_ROOT="$(cd "$BROWSER_DIR/../.." && pwd)"

NETHACK_WASM="$REPO_ROOT/examples/libs/nethack/bin/nethack.wasm"
RUNTIME_DIR="$REPO_ROOT/examples/libs/nethack/runtime"
OUTPUT_DIR="$BROWSER_DIR/public"
OUTPUT_FILE="$OUTPUT_DIR/nethack.zip"

if [ ! -f "$NETHACK_WASM" ]; then
    echo "nethack.wasm not found. Run: bash examples/libs/nethack/build-nethack.sh" >&2
    exit 1
fi

if [ ! -d "$RUNTIME_DIR/share/nethack" ]; then
    echo "NetHack runtime not found. Run: bash examples/libs/nethack/build-nethack.sh" >&2
    exit 1
fi

mkdir -p "$OUTPUT_DIR"
rm -f "$OUTPUT_FILE"

STAGING=$(mktemp -d)
trap 'rm -rf "$STAGING"' EXIT

echo "==> Staging nethack.zip..."

# Binary — stored at bin/nethack (no .wasm extension, matching the VFS layout)
mkdir -p "$STAGING/bin"
cp "$NETHACK_WASM" "$STAGING/bin/nethack"
chmod 755 "$STAGING/bin/nethack"

# Runtime files — staged under share/nethack/
mkdir -p "$STAGING/share/nethack"
rsync -a "$RUNTIME_DIR/share/nethack/" "$STAGING/share/nethack/"

(cd "$STAGING" && zip -r -q "$OUTPUT_FILE" .)

echo "    $(find "$STAGING" -type f | wc -l | tr -d ' ') files"
ls -lh "$OUTPUT_FILE"
