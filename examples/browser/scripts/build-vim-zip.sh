#!/usr/bin/env bash
#
# Build vim.zip for the browser shell demo.
#
# Packages vim.wasm plus the minimal runtime tree (syntax/ftplugin/etc.) into
# a single archive. The demo registers this as a lazy archive with mount
# prefix /usr/, so entries become /usr/bin/vim and /usr/share/vim/vim91/...
# On first exec of vim, the whole archive is fetched and unpacked in one go.
#
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
BROWSER_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
REPO_ROOT="$(cd "$BROWSER_DIR/../.." && pwd)"

VIM_WASM="$REPO_ROOT/examples/libs/vim/bin/vim.wasm"
RUNTIME_DIR="$REPO_ROOT/examples/libs/vim/runtime"
OUTPUT_DIR="$BROWSER_DIR/public"
OUTPUT_FILE="$OUTPUT_DIR/vim.zip"

if [ ! -f "$VIM_WASM" ]; then
    echo "vim.wasm not found. Run: bash examples/libs/vim/build-vim.sh" >&2
    exit 1
fi

if [ ! -d "$RUNTIME_DIR" ]; then
    echo "Vim runtime not found. Run: bash examples/libs/vim/bundle-runtime.sh" >&2
    exit 1
fi

mkdir -p "$OUTPUT_DIR"
rm -f "$OUTPUT_FILE"

STAGING=$(mktemp -d)
trap 'rm -rf "$STAGING"' EXIT

echo "==> Staging vim.zip..."

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
