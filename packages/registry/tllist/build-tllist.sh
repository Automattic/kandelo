#!/usr/bin/env bash
#
# Stage tllist (header-only) for wasm32-posix-kernel.
#
# Honors the dep-resolver build-script contract (see
# docs/package-management.md). Nothing compiles: the package fetches
# the release tarball and installs the one header plus a .pc so
# fcft's and foot's dependency lookups resolve.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
SRC_DIR="$SCRIPT_DIR/tllist-src"

TLLIST_VERSION="${WASM_POSIX_DEP_VERSION:-1.1.0}"
INSTALL_DIR="${WASM_POSIX_DEP_OUT_DIR:-$SCRIPT_DIR/tllist-install}"
SOURCE_URL="${WASM_POSIX_DEP_SOURCE_URL:-https://codeberg.org/dnkl/tllist/releases/download/${TLLIST_VERSION}/tllist-${TLLIST_VERSION}.tar.gz}"
SOURCE_SHA256="${WASM_POSIX_DEP_SOURCE_SHA256:-}"

# --- Fetch + verify source ---
if [ ! -d "$SRC_DIR" ]; then
    echo "==> Downloading tllist $TLLIST_VERSION..."
    TARBALL="/tmp/tllist-${TLLIST_VERSION}.tar.gz"
    curl --retry 10 --retry-delay 5 --retry-max-time 300 --retry-all-errors -fsSL "$SOURCE_URL" -o "$TARBALL"
    if [ -n "$SOURCE_SHA256" ]; then
        echo "==> Verifying source sha256..."
        echo "$SOURCE_SHA256  $TARBALL" | shasum -a 256 -c -
    fi
    mkdir -p "$SRC_DIR"
    tar xzf "$TARBALL" -C "$SRC_DIR" --strip-components=1
    rm "$TARBALL"
fi

# The resolver-created output directory is itself publication authority, so
# a recipe must populate that inode rather than delete and recreate it.
if [ -n "${WASM_POSIX_DEP_OUT_DIR:-}" ]; then
    if [ -n "$(find "$INSTALL_DIR" -mindepth 1 -print -quit)" ]; then
        echo "ERROR: tllist resolver output directory must start empty" >&2
        exit 1
    fi
else
    rm -rf "$INSTALL_DIR"
fi
mkdir -p "$INSTALL_DIR/include" "$INSTALL_DIR/lib/pkgconfig"

cp "$SRC_DIR/tllist.h" "$INSTALL_DIR/include/tllist.h"

cat > "$INSTALL_DIR/lib/pkgconfig/tllist.pc" <<EOF
prefix=$INSTALL_DIR
includedir=\${prefix}/include

Name: tllist
Description: Typed linked list C header library
Version: $TLLIST_VERSION
Cflags: -I\${includedir}
EOF

echo "==> tllist staged!"
ls -l "$INSTALL_DIR/include/tllist.h"
