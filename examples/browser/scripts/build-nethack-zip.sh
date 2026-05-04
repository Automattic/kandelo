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
# Sources nethack.wasm + runtime/ from the resolver cache canonical dir
# (populated by `cargo xtask build-deps resolve nethack`, which either
# runs build-nethack.sh or fetches the release archive). Falls back to
# the in-tree source layout `examples/libs/nethack/{bin,runtime}` when a
# cache lookup fails — useful while iterating on build-nethack.sh
# without going through the resolver.
#
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
BROWSER_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
REPO_ROOT="$(cd "$BROWSER_DIR/../.." && pwd)"

OUTPUT_DIR="$BROWSER_DIR/public"
OUTPUT_FILE="$OUTPUT_DIR/nethack.zip"

# Resolve the nethack package via the resolver. Returns the cache
# canonical directory containing nethack.wasm + runtime/share/nethack/.
HOST_TARGET="$(rustc -vV | awk '/^host/ {print $2}')"
NETHACK_DIR="$(cd "$REPO_ROOT" && cargo run -p xtask --target "$HOST_TARGET" --quiet -- \
    build-deps resolve nethack --arch wasm32 2>/dev/null || true)"

NETHACK_WASM=""
RUNTIME_ROOT=""
if [ -n "$NETHACK_DIR" ] && [ -f "$NETHACK_DIR/nethack.wasm" ] \
   && [ -d "$NETHACK_DIR/runtime/share/nethack" ]; then
    NETHACK_WASM="$NETHACK_DIR/nethack.wasm"
    RUNTIME_ROOT="$NETHACK_DIR/runtime/share/nethack"
elif [ -f "$REPO_ROOT/examples/libs/nethack/bin/nethack.wasm" ] \
   && [ -d "$REPO_ROOT/examples/libs/nethack/runtime/share/nethack" ]; then
    # Fallback: in-tree build artifacts.
    NETHACK_WASM="$REPO_ROOT/examples/libs/nethack/bin/nethack.wasm"
    RUNTIME_ROOT="$REPO_ROOT/examples/libs/nethack/runtime/share/nethack"
else
    echo "nethack package not found." >&2
    echo "  cache lookup: ${NETHACK_DIR:-<resolve failed>}" >&2
    echo "  expected: nethack.wasm + runtime/share/nethack/ in cache canonical dir" >&2
    echo "  or build locally: bash examples/libs/nethack/build-nethack.sh" >&2
    exit 1
fi

mkdir -p "$OUTPUT_DIR"
rm -f "$OUTPUT_FILE"

STAGING=$(mktemp -d)
trap 'rm -rf "$STAGING"' EXIT

echo "==> Staging nethack.zip..."
echo "    binary:  $NETHACK_WASM"
echo "    runtime: $RUNTIME_ROOT"

# Binary — stored at bin/nethack (no .wasm extension, matching the VFS layout)
mkdir -p "$STAGING/bin"
cp "$NETHACK_WASM" "$STAGING/bin/nethack"
chmod 755 "$STAGING/bin/nethack"

# Runtime files — staged under share/nethack/
mkdir -p "$STAGING/share/nethack"
rsync -a "$RUNTIME_ROOT/" "$STAGING/share/nethack/"

(cd "$STAGING" && zip -r -q "$OUTPUT_FILE" .)

echo "    $(find "$STAGING" -type f | wc -l | tr -d ' ') files"
ls -lh "$OUTPUT_FILE"

# Install into local-binaries/ so the resolver picks the locally-built
# nethack.zip over a fetched release. Mirrors examples/browser/scripts/
# build-vim-zip.sh.
source "$REPO_ROOT/scripts/install-local-binary.sh"
install_local_binary nethack "$OUTPUT_FILE"
