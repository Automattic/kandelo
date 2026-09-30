#!/usr/bin/env bash
#
# Build fribidi (libfribidi.a) for wasm32-posix-kernel.
#
# Honors the dep-resolver build-script contract (see
# docs/package-management.md). Plain autoconf cross-build like expat.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"
# shellcheck source=/dev/null
source "$REPO_ROOT/scripts/package-build-roots.sh"
# Build under the package work root: the resolver's fresh
# WASM_POSIX_DEP_WORK_DIR, or this directory for a direct invocation. A
# source or build tree kept in the package directory survives the rebuilds
# the resolver runs after a recipe, patch, toolchain, or ABI change, so the
# "rebuilt" package would be made from the previous build's tree.
kandelo_package_prepare_build_roots "$SCRIPT_DIR" wasm32
WORK_DIR="$KANDELO_PACKAGE_WORK_DIR"
SRC_DIR="$WORK_DIR/fribidi-src"

FRIBIDI_VERSION="${WASM_POSIX_DEP_VERSION:-1.0.16}"
INSTALL_DIR="${WASM_POSIX_DEP_OUT_DIR:-$SCRIPT_DIR/fribidi-install}"
SOURCE_URL="${WASM_POSIX_DEP_SOURCE_URL:-https://github.com/fribidi/fribidi/releases/download/v${FRIBIDI_VERSION}/fribidi-${FRIBIDI_VERSION}.tar.xz}"
SOURCE_SHA256="${WASM_POSIX_DEP_SOURCE_SHA256:-}"

BUILD_DIR="$WORK_DIR/fribidi-build"

if ! command -v wasm32posix-cc &>/dev/null; then
    echo "ERROR: wasm32posix-cc not found. Enter scripts/dev-shell.sh." >&2
    exit 1
fi

# --- Fetch + verify source ---
if [ ! -d "$SRC_DIR" ]; then
    echo "==> Downloading fribidi $FRIBIDI_VERSION..."
    TARBALL="$WORK_DIR/fribidi-${FRIBIDI_VERSION}.tar.xz"
    curl --retry 10 --retry-delay 5 --retry-max-time 300 --retry-all-errors -fsSL "$SOURCE_URL" -o "$TARBALL"
    if [ -n "$SOURCE_SHA256" ]; then
        echo "==> Verifying source sha256..."
        echo "$SOURCE_SHA256  $TARBALL" | shasum -a 256 -c -
    else
        echo "==> (no SOURCE_SHA256 declared; skipping verification)"
    fi
    mkdir -p "$SRC_DIR"
    tar xJf "$TARBALL" -C "$SRC_DIR" --strip-components=1
    rm "$TARBALL"
fi

# Fresh build + install dir each run — autoconf bakes --prefix into
# Makefiles.
rm -rf "$BUILD_DIR"
# The resolver-created output directory is itself publication authority, so
# a recipe must populate that inode rather than delete and recreate it.
if [ -n "${WASM_POSIX_DEP_OUT_DIR:-}" ]; then
    if [ -n "$(find "$INSTALL_DIR" -mindepth 1 -print -quit)" ]; then
        echo "ERROR: fribidi resolver output directory must start empty" >&2
        exit 1
    fi
else
    rm -rf "$INSTALL_DIR"
fi
mkdir -p "$BUILD_DIR"

echo "==> Configuring fribidi for wasm32..."
(
    cd "$BUILD_DIR"
    CFLAGS="-O2" \
    "$SRC_DIR/configure" \
        --host=wasm32-unknown-none \
        --prefix="$INSTALL_DIR" \
        --enable-static \
        --disable-shared \
        --disable-debug \
        --disable-deprecated \
        CC=wasm32posix-cc \
        AR=wasm32posix-ar \
        RANLIB=wasm32posix-ranlib

    echo "==> Building fribidi..."
    make -j"$(sysctl -n hw.ncpu 2>/dev/null || nproc)" -C lib

    echo "==> Installing to $INSTALL_DIR..."
    make -C lib install
    make install-pkgconfigDATA
)

if [ -f "$INSTALL_DIR/lib/libfribidi.a" ]; then
    echo "==> fribidi build complete!"
    ls -lh "$INSTALL_DIR/lib/libfribidi.a"
else
    echo "ERROR: Build failed — library not found at $INSTALL_DIR/lib/libfribidi.a" >&2
    exit 1
fi
