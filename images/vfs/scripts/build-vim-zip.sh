#!/usr/bin/env bash
#
# Build vim.zip for the browser shell demo.
#
# Packages vim.wasm plus the minimal runtime tree (syntax/ftplugin/etc.) into
# a single archive. The demo registers this as a lazy archive with mount
# prefix /usr/, so entries become /usr/bin/vim and /usr/share/vim/vim91/...
# On first exec of vim, the whole archive is fetched and unpacked in one go.
#
# With `<dependency-dir> <output.zip>`, consumes only that exact declared
# dependency and writes only the selected output. With no arguments, retains
# the standalone developer mode: resolve Vim, write the browser public asset,
# and install the result into the ordinary local mirror.
#
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"

INSTALL_LOCAL_MIRROR=0
case "$#" in
    0)
        OUTPUT_FILE="$REPO_ROOT/apps/browser-demos/public/vim.zip"
        # Standalone developer mode resolves the package on demand. Canonical
        # package builds pass their direct dependency explicitly instead.
        HOST_TARGET="$(rustc -vV | awk '/^host/ {print $2}')"
        VIM_DIR="$(cd "$REPO_ROOT" && cargo run -p xtask --target "$HOST_TARGET" --quiet -- \
            build-deps resolve vim --arch wasm32 2>/dev/null || true)"
        INSTALL_LOCAL_MIRROR=1
        ;;
    2)
        VIM_DIR="$1"
        OUTPUT_FILE="$2"
        ;;
    *)
        echo "usage: $0 [<dependency-dir> <output.zip>]" >&2
        exit 2
        ;;
esac

VIM_WASM=""
RUNTIME_DIR=""
if [ -n "$VIM_DIR" ] && [ -f "$VIM_DIR/vim.wasm" ] && [ -d "$VIM_DIR/runtime" ]; then
    VIM_WASM="$VIM_DIR/vim.wasm"
    RUNTIME_DIR="$VIM_DIR/runtime"
elif [ -f "$REPO_ROOT/packages/registry/vim/bin/vim.wasm" ] \
   && [ -d "$REPO_ROOT/packages/registry/vim/runtime" ]; then
    # Fallback: in-tree build artifacts.
    VIM_WASM="$REPO_ROOT/packages/registry/vim/bin/vim.wasm"
    RUNTIME_DIR="$REPO_ROOT/packages/registry/vim/runtime"
else
    echo "vim package not found." >&2
    echo "  cache lookup: ${VIM_DIR:-<resolve failed>}" >&2
    echo "  expected: vim.wasm + runtime/ in cache canonical dir" >&2
    echo "  or build locally: bash packages/registry/vim/build-vim.sh" >&2
    exit 1
fi

OUTPUT_DIR="$(dirname "$OUTPUT_FILE")"
mkdir -p "$OUTPUT_DIR"
rm -f "$OUTPUT_FILE"

if [ -n "${WASM_POSIX_DEP_WORK_DIR:-}" ]; then
    STAGING="$(mktemp -d "$WASM_POSIX_DEP_WORK_DIR/vim-zip.XXXXXX")"
else
    STAGING="$(mktemp -d)"
fi
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
cp -R "$RUNTIME_DIR/." "$STAGING/share/vim/vim91/"

bash "$SCRIPT_DIR/create-deterministic-zip.sh" "$STAGING" "$OUTPUT_FILE"

echo "    $(find "$STAGING" -type f | wc -l | tr -d ' ') files"
ls -lh "$OUTPUT_FILE"

# Install into local-binaries/ so the resolver picks the locally-built
# vim.zip over the fetched release. This ZIP is the declared output of
# vim-browser-bundle, not vim: vim owns vim.wasm and its runtime tree.
# Keeping that ownership exact lets the resolver validate the output against
# the same package manifest that archive-stage is currently building.
if [ "$INSTALL_LOCAL_MIRROR" -eq 1 ]; then
    source "$REPO_ROOT/scripts/install-local-binary.sh"
    install_local_binary vim-browser-bundle "$OUTPUT_FILE" vim.zip
fi
