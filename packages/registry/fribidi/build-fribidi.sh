#!/usr/bin/env bash
#
# Build fribidi (libfribidi.a) for wasm32-posix-kernel.
#
# Honors the dep-resolver build-script contract (see
# docs/package-management.md). Plain autoconf cross-build like expat.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
SRC_DIR="$SCRIPT_DIR/fribidi-src"

FRIBIDI_VERSION="${WASM_POSIX_DEP_VERSION:-1.0.16}"
INSTALL_DIR="${WASM_POSIX_DEP_OUT_DIR:-$SCRIPT_DIR/fribidi-install}"
SOURCE_URL="${WASM_POSIX_DEP_SOURCE_URL:-https://github.com/fribidi/fribidi/releases/download/v${FRIBIDI_VERSION}/fribidi-${FRIBIDI_VERSION}.tar.xz}"
SOURCE_SHA256="${WASM_POSIX_DEP_SOURCE_SHA256:-}"

BUILD_DIR="$SCRIPT_DIR/fribidi-build"

if ! command -v wasm32posix-cc &>/dev/null; then
    echo "ERROR: wasm32posix-cc not found. Enter scripts/dev-shell.sh." >&2
    exit 1
fi

# --- Fetch + verify source ---
if [ ! -d "$SRC_DIR" ]; then
    echo "==> Downloading fribidi $FRIBIDI_VERSION..."
    TARBALL="/tmp/fribidi-${FRIBIDI_VERSION}.tar.xz"
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
rm -rf "$BUILD_DIR" "$INSTALL_DIR"
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
