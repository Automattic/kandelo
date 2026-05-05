#!/usr/bin/env bash
#
# Build vim.zip for the browser shell demo.
#
# Packages vim.wasm plus the minimal runtime tree (syntax/ftplugin/etc.) into
# a single archive. The demo registers this as a lazy archive with mount
# prefix /usr/, so entries become /usr/bin/vim and /usr/share/vim/vim91/...
# On first exec of vim, the whole archive is fetched and unpacked in one go.
#
# Sources vim.wasm + runtime/ from the resolver cache canonical dir
# (populated by `cargo xtask build-deps resolve vim`, which either runs
# build-vim.sh or fetches the release archive). Falls back to the in-tree
# source layout `examples/libs/vim/{bin,runtime}` when a cache lookup
# fails — useful while iterating on build-vim.sh without going through
# the resolver. Mirrors examples/browser/scripts/build-nethack-zip.sh.
#
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
BROWSER_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
REPO_ROOT="$(cd "$BROWSER_DIR/../.." && pwd)"

OUTPUT_DIR="$BROWSER_DIR/public"
OUTPUT_FILE="$OUTPUT_DIR/vim.zip"

# Resolve the vim package via the resolver. Returns the cache canonical
# directory containing vim.wasm + runtime/<vim runtime tree>.
HOST_TARGET="$(rustc -vV | awk '/^host/ {print $2}')"
VIM_DIR="$(cd "$REPO_ROOT" && cargo run -p xtask --target "$HOST_TARGET" --quiet -- \
    build-deps resolve vim --arch wasm32 2>/dev/null || true)"

VIM_WASM=""
RUNTIME_DIR=""
if [ -n "$VIM_DIR" ] && [ -f "$VIM_DIR/vim.wasm" ] && [ -d "$VIM_DIR/runtime" ]; then
    VIM_WASM="$VIM_DIR/vim.wasm"
    RUNTIME_DIR="$VIM_DIR/runtime"
elif [ -f "$REPO_ROOT/examples/libs/vim/bin/vim.wasm" ] \
   && [ -d "$REPO_ROOT/examples/libs/vim/runtime" ]; then
    # Fallback: in-tree build artifacts.
    VIM_WASM="$REPO_ROOT/examples/libs/vim/bin/vim.wasm"
    RUNTIME_DIR="$REPO_ROOT/examples/libs/vim/runtime"
else
    echo "vim package not found." >&2
    echo "  cache lookup: ${VIM_DIR:-<resolve failed>}" >&2
    echo "  expected: vim.wasm + runtime/ in cache canonical dir" >&2
    echo "  or build locally: bash examples/libs/vim/build-vim.sh" >&2
    exit 1
fi

mkdir -p "$OUTPUT_DIR"
rm -f "$OUTPUT_FILE"

STAGING=$(mktemp -d)
trap 'rm -rf "$STAGING"' EXIT

echo "==> Staging vim.zip..."
echo "    binary:  $VIM_WASM"
echo "    runtime: $RUNTIME_DIR"

# Binary — stored at bin/vim (no .wasm extension, matching the VFS layout)
mkdir -p "$STAGING/bin"
cp "$VIM_WASM" "$STAGING/bin/vim"
chmod 755 "$STAGING/bin/vim"

# Runtime files — staged under share/vim/vim91/
mkdir -p "$STAGING/share/vim/vim91"
rsync -a "$RUNTIME_DIR/" "$STAGING/share/vim/vim91/"

(cd "$STAGING" && zip -r -q "$OUTPUT_FILE" .)

echo "    $(find "$STAGING" -type f | wc -l | tr -d ' ') files"
ls -lh "$OUTPUT_FILE"

# Install into local-binaries/ so the resolver picks the locally-built
# vim.zip over the fetched release. In the release layout vim is a
# single-asset program (the zip IS the bundle), so no dest-name
# argument — the helper drops it at local-binaries/programs/vim.zip.
source "$REPO_ROOT/scripts/install-local-binary.sh"
install_local_binary vim "$OUTPUT_FILE"
