#!/usr/bin/env bash
#
# Build expat (libexpat.a) for wasm32-posix-kernel.
#
# Honors the dep-resolver build-script contract (see
# docs/package-management.md). When invoked via
# `cargo xtask build-deps resolve expat`, env vars are set by the
# resolver and the build installs into the shared cache:
#
#     WASM_POSIX_DEP_OUT_DIR        # where to `make install`
#     WASM_POSIX_DEP_VERSION        # upstream version
#     WASM_POSIX_DEP_SOURCE_URL     # tarball URL
#     WASM_POSIX_DEP_SOURCE_SHA256  # expected sha256 of the tarball
#
# For ad-hoc / legacy invocation (`bash build-expat.sh`), the script
# falls back to the in-tree `expat-install/` layout.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
SRC_DIR="$SCRIPT_DIR/expat-src"

# --- Inputs from resolver, with legacy fallbacks ---
EXPAT_VERSION="${WASM_POSIX_DEP_VERSION:-${EXPAT_VERSION:-2.8.3}}"
INSTALL_DIR="${WASM_POSIX_DEP_OUT_DIR:-$SCRIPT_DIR/expat-install}"
SOURCE_URL="${WASM_POSIX_DEP_SOURCE_URL:-https://github.com/libexpat/libexpat/releases/download/R_$(echo "$EXPAT_VERSION" | tr . _)/expat-${EXPAT_VERSION}.tar.xz}"
SOURCE_SHA256="${WASM_POSIX_DEP_SOURCE_SHA256:-}"

# autoconf bakes --prefix into the Makefile, so always build in a
# fresh dir rather than reusing a stale expat-build/.
BUILD_DIR="$SCRIPT_DIR/expat-build"

if ! command -v wasm32posix-cc &>/dev/null; then
    echo "ERROR: wasm32posix-cc not found. Run 'npm link' in sdk/ first." >&2
    exit 1
fi

# --- Fetch + verify source ---
if [ ! -d "$SRC_DIR" ]; then
    echo "==> Downloading expat $EXPAT_VERSION..."
    TARBALL="/tmp/expat-${EXPAT_VERSION}.tar.xz"
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

# Fresh build + install dir each run. The cache path varies per key
# and autoconf-generated Makefiles are not portable across prefixes.
rm -rf "$BUILD_DIR"
# The resolver-created output directory is itself publication authority, so
# a recipe must populate that inode rather than delete and recreate it.
if [ -n "${WASM_POSIX_DEP_OUT_DIR:-}" ]; then
    if [ -n "$(find "$INSTALL_DIR" -mindepth 1 -print -quit)" ]; then
        echo "ERROR: expat resolver output directory must start empty" >&2
        exit 1
    fi
else
    rm -rf "$INSTALL_DIR"
fi
mkdir -p "$BUILD_DIR"

echo "==> Configuring expat for wasm32..."
(
    cd "$BUILD_DIR"
    CFLAGS="-O2" \
    "$SRC_DIR/configure" \
        --host=wasm32-unknown-none \
        --prefix="$INSTALL_DIR" \
        --enable-static \
        --disable-shared \
        --without-xmlwf \
        --without-examples \
        --without-tests \
        --without-docbook \
        CC=wasm32posix-cc \
        AR=wasm32posix-ar \
        RANLIB=wasm32posix-ranlib

    echo "==> Building expat..."
    make -j"$(sysctl -n hw.ncpu 2>/dev/null || nproc)"

    echo "==> Installing to $INSTALL_DIR..."
    make install
)

rm -rf "$INSTALL_DIR/share"

if [ -f "$INSTALL_DIR/lib/libexpat.a" ]; then
    echo "==> expat build complete!"
    ls -lh "$INSTALL_DIR/lib/"libexpat*.a
else
    echo "ERROR: Build failed — library not found at $INSTALL_DIR/lib/libexpat.a" >&2
    exit 1
fi
