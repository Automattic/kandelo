#!/usr/bin/env bash
#
# Build utf8proc (libutf8proc.a) for wasm32-posix-kernel.
#
# Honors the dep-resolver build-script contract (see
# docs/package-management.md). utf8proc is one freestanding TU (its
# Unicode tables are a second TU #included by the first), so we compile
# it directly rather than driving upstream's Makefile — nothing to
# configure, no host probes to defeat.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
SRC_DIR="$SCRIPT_DIR/utf8proc-src"

UTF8PROC_VERSION="${WASM_POSIX_DEP_VERSION:-2.9.0}"
INSTALL_DIR="${WASM_POSIX_DEP_OUT_DIR:-$SCRIPT_DIR/utf8proc-install}"
SOURCE_URL="${WASM_POSIX_DEP_SOURCE_URL:-https://github.com/JuliaStrings/utf8proc/releases/download/v${UTF8PROC_VERSION}/utf8proc-${UTF8PROC_VERSION}.tar.gz}"
SOURCE_SHA256="${WASM_POSIX_DEP_SOURCE_SHA256:-}"

if ! command -v wasm32posix-cc &>/dev/null; then
    echo "ERROR: wasm32posix-cc not found. Enter scripts/dev-shell.sh." >&2
    exit 1
fi

# --- Fetch + verify source ---
if [ ! -d "$SRC_DIR" ]; then
    echo "==> Downloading utf8proc $UTF8PROC_VERSION..."
    TARBALL="/tmp/utf8proc-${UTF8PROC_VERSION}.tar.gz"
    curl --retry 10 --retry-delay 5 --retry-max-time 300 --retry-all-errors -fsSL "$SOURCE_URL" -o "$TARBALL"
    if [ -n "$SOURCE_SHA256" ]; then
        echo "==> Verifying source sha256..."
        echo "$SOURCE_SHA256  $TARBALL" | shasum -a 256 -c -
    fi
    mkdir -p "$SRC_DIR"
    tar xzf "$TARBALL" -C "$SRC_DIR" --strip-components=1
    rm "$TARBALL"
fi

BUILD_DIR="$SCRIPT_DIR/utf8proc-build"
rm -rf "$BUILD_DIR"
# The resolver-created output directory is itself publication authority, so
# a recipe must populate that inode rather than delete and recreate it.
if [ -n "${WASM_POSIX_DEP_OUT_DIR:-}" ]; then
    if [ -n "$(find "$INSTALL_DIR" -mindepth 1 -print -quit)" ]; then
        echo "ERROR: utf8proc resolver output directory must start empty" >&2
        exit 1
    fi
else
    rm -rf "$INSTALL_DIR"
fi
mkdir -p "$BUILD_DIR" "$INSTALL_DIR/lib/pkgconfig" "$INSTALL_DIR/include"

echo "==> Compiling utf8proc for wasm32..."
wasm32posix-cc -c -O2 -fPIC -DUTF8PROC_STATIC \
    "$SRC_DIR/utf8proc.c" -o "$BUILD_DIR/utf8proc.o"
wasm32posix-ar rcs "$INSTALL_DIR/lib/libutf8proc.a" "$BUILD_DIR/utf8proc.o"

cp "$SRC_DIR/utf8proc.h" "$INSTALL_DIR/include/utf8proc.h"

# Upstream's Makefile installs the .pc as libutf8proc.pc; fcft's
# dependency lookup uses that name.
cat > "$INSTALL_DIR/lib/pkgconfig/libutf8proc.pc" <<EOF
prefix=$INSTALL_DIR
libdir=\${prefix}/lib
includedir=\${prefix}/include

Name: libutf8proc
Description: UTF-8 processing library
Version: $UTF8PROC_VERSION
Libs: -L\${libdir} -lutf8proc
Cflags: -I\${includedir} -DUTF8PROC_STATIC
EOF

echo "==> utf8proc build complete!"
ls -lh "$INSTALL_DIR/lib/libutf8proc.a"
