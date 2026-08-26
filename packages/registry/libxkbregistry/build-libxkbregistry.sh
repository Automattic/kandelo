#!/usr/bin/env bash
#
# Build libxkbregistry.a for wasm32-posix-kernel, from the same
# libxkbcommon 1.7.0 tarball the libxkbcommon package pins. One TU
# (src/registry.c) against libxml2, compiled with the meson-bypass
# pattern and libxkbcommon's hand-curated config.h.
#
# Honors the dep-resolver build-script contract (docs/package-management.md):
# when invoked via `cargo xtask build-deps resolve libxkbregistry` the
# resolver sets WASM_POSIX_DEP_OUT_DIR / _VERSION / _SOURCE_URL /
# _SOURCE_SHA256 / WASM_POSIX_DEP_LIBXML2_DIR.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
SRC_DIR="$SCRIPT_DIR/xkbregistry-src"

XKB_VERSION="${WASM_POSIX_DEP_VERSION:-1.7.0}"
INSTALL_DIR="${WASM_POSIX_DEP_OUT_DIR:-$SCRIPT_DIR/libxkbregistry-install}"
SOURCE_URL="${WASM_POSIX_DEP_SOURCE_URL:-https://xkbcommon.org/download/libxkbcommon-${XKB_VERSION}.tar.xz}"
SOURCE_SHA256="${WASM_POSIX_DEP_SOURCE_SHA256:-}"

LIBXML2_PREFIX="${WASM_POSIX_DEP_LIBXML2_DIR:?WASM_POSIX_DEP_LIBXML2_DIR not set (must be invoked via cargo xtask build-deps resolve libxkbregistry)}"

if ! command -v wasm32posix-cc &>/dev/null; then
    echo "ERROR: wasm32posix-cc not found. Enter scripts/dev-shell.sh." >&2
    exit 1
fi

# --- Fetch + verify source ---------------------------------------------
if [ ! -d "$SRC_DIR" ]; then
    echo "==> Downloading libxkbcommon $XKB_VERSION..."
    TARBALL="/tmp/libxkbcommon-registry-${XKB_VERSION}.tar.xz"
    curl --retry 10 --retry-delay 5 --retry-max-time 300 --retry-all-errors \
        -fsSL "$SOURCE_URL" -o "$TARBALL"
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

BUILD_DIR="$SCRIPT_DIR/xkbregistry-build"
rm -rf "$BUILD_DIR"
# The resolver-created output directory is itself publication authority, so
# a recipe must populate that inode rather than delete and recreate it.
if [ -n "${WASM_POSIX_DEP_OUT_DIR:-}" ]; then
    if [ -n "$(find "$INSTALL_DIR" -mindepth 1 -print -quit)" ]; then
        echo "ERROR: libxkbregistry resolver output directory must start empty" >&2
        exit 1
    fi
else
    rm -rf "$INSTALL_DIR"
fi
mkdir -p "$BUILD_DIR" "$INSTALL_DIR/lib" "$INSTALL_DIR/include/xkbcommon"

SRC="$SRC_DIR/src"
cp "$SCRIPT_DIR/../libxkbcommon/src/config.h" "$SRC_DIR/config.h"

echo "==> Compiling registry.c + util-list.c for wasm32..."
OBJS=()
for tu in registry.c util-list.c; do
    obj="$BUILD_DIR/${tu%.c}.o"
    wasm32posix-cc -c \
        -O2 -fPIC -fvisibility=hidden -std=gnu11 \
        "-I$SRC_DIR" \
        "-I$SRC" \
        "-I$SRC_DIR/include" \
        "-I$LIBXML2_PREFIX/include" \
        -Wno-unused-parameter \
        "$SRC/$tu" -o "$obj"
    OBJS+=("$obj")
done

echo "==> Archiving libxkbregistry.a..."
wasm32posix-ar rcs "$INSTALL_DIR/lib/libxkbregistry.a" "${OBJS[@]}"

echo "==> Installing header..."
cp "$SRC_DIR/include/xkbcommon/xkbregistry.h" \
   "$INSTALL_DIR/include/xkbcommon/xkbregistry.h"

echo "==> Writing xkbregistry.pc..."
PC_DIR="$INSTALL_DIR/lib/pkgconfig"
mkdir -p "$PC_DIR"
cat > "$PC_DIR/xkbregistry.pc" <<EOF
prefix=$INSTALL_DIR
libdir=\${prefix}/lib
includedir=\${prefix}/include

Name: xkbregistry
Description: XKB API to query available rules, models, layouts, variants and options
Version: $XKB_VERSION
Requires.private: libxml-2.0
Libs: -L\${libdir} -lxkbregistry
Cflags: -I\${includedir}
EOF

echo "==> libxkbregistry $XKB_VERSION installed at $INSTALL_DIR"
echo "    lib/libxkbregistry.a ($(wc -c < "$INSTALL_DIR/lib/libxkbregistry.a") bytes)"
