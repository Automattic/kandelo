#!/usr/bin/env bash
#
# Install wlr-protocols (protocol XML + wlr-protocols.pc) for
# wasm32-posix-kernel with upstream's Makefile. Nothing is compiled.
#
# Honors the dep-resolver build-script contract (see
# docs/package-management.md). When invoked via
# `cargo xtask build-deps resolve wlr-protocols`, env vars are set by the
# resolver:
#
#     WASM_POSIX_DEP_OUT_DIR          # install prefix
#     WASM_POSIX_DEP_VERSION          # package version
#     WASM_POSIX_DEP_SOURCE_URL       # commit archive URL
#     WASM_POSIX_DEP_SOURCE_SHA256    # expected sha256 of the archive

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"
source "$REPO_ROOT/scripts/package-build-roots.sh"
kandelo_package_load_source_metadata "$SCRIPT_DIR"
kandelo_package_prepare_build_roots "$SCRIPT_DIR" wasm32
SRC_DIR="$KANDELO_PACKAGE_WORK_DIR/wlr-protocols-src"

WLR_VERSION="$WASM_POSIX_DEP_VERSION"
INSTALL_DIR="${WASM_POSIX_DEP_OUT_DIR:-$SCRIPT_DIR/wlr-protocols-install}"
SOURCE_URL="$WASM_POSIX_DEP_SOURCE_URL"
SOURCE_SHA256="$WASM_POSIX_DEP_SOURCE_SHA256"

# --- Stage verified source ---
# Fresh each run: the Makefile writes wlr-protocols.pc into the source tree.
rm -rf "$SRC_DIR"
echo "==> Staging verified wlr-protocols $WLR_VERSION source..."
kandelo_package_stage_verified_source wlr-protocols "$SRC_DIR" \
    "${WASM_POSIX_DEP_SOURCE_DIR:-}" "$SOURCE_URL" "$SOURCE_SHA256" \
    "$KANDELO_PACKAGE_WORK_DIR"

# The resolver-created output directory is itself publication authority, so
# a recipe must populate that inode rather than delete and recreate it.
if [ -n "${WASM_POSIX_DEP_OUT_DIR:-}" ]; then
    if [ -n "$(find "$INSTALL_DIR" -mindepth 1 -print -quit)" ]; then
        echo "ERROR: wlr-protocols resolver output directory must start empty" >&2
        exit 1
    fi
else
    rm -rf "$INSTALL_DIR"
fi

# The resolver moves the output to its cache path after the build and
# rewrites the prefix only in lib/pkgconfig/*.pc, so the .pc derives its
# prefix from its own location. The files install under DESTDIR with an
# empty PREFIX; the .pc is already generated, so install-pc keeps it.
echo "==> Installing to $INSTALL_DIR..."
make -C "$SRC_DIR" wlr-protocols.pc PREFIX='$${pcfiledir}/../..'
make -C "$SRC_DIR" install DESTDIR="$INSTALL_DIR" PREFIX=

for f in share/pkgconfig/wlr-protocols.pc \
         share/wlr-protocols/unstable/wlr-layer-shell-unstable-v1.xml; do
    if [ ! -f "$INSTALL_DIR/$f" ]; then
        echo "ERROR: Install failed — $f not found under $INSTALL_DIR" >&2
        exit 1
    fi
done

echo "==> wlr-protocols $WLR_VERSION install complete!"
