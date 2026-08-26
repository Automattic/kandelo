#!/usr/bin/env bash
#
# Build fcft (libfcft.a) for wasm32-posix-kernel.
#
# Honors the dep-resolver build-script contract (see
# docs/package-management.md). fcft is meson-only upstream, so we
# bypass it like libxkbcommon/libwayland: run the three upstream
# header generators (version.h, unicode-compose-table.h from
# UnicodeData.txt, emoji-data.h via python3) and compile the two TUs
# directly. No harfbuzz → no grapheme/run shaping and no
# FCFT_HAVE_UTF8PROC (its only uses sit behind the harfbuzz guards);
# svg-backend=disabled → the nanosvg TUs stay out.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
SRC_DIR="$SCRIPT_DIR/fcft-src"

FCFT_VERSION="${WASM_POSIX_DEP_VERSION:-3.1.9}"
INSTALL_DIR="${WASM_POSIX_DEP_OUT_DIR:-$SCRIPT_DIR/fcft-install}"
SOURCE_URL="${WASM_POSIX_DEP_SOURCE_URL:-https://codeberg.org/dnkl/fcft/releases/download/${FCFT_VERSION}/fcft-${FCFT_VERSION}.tar.gz}"
SOURCE_SHA256="${WASM_POSIX_DEP_SOURCE_SHA256:-}"

BUILD_DIR="$SCRIPT_DIR/fcft-build"

for tool in wasm32posix-cc wasm32posix-ar python3; do
    if ! command -v "$tool" &>/dev/null; then
        echo "ERROR: $tool not found. Enter scripts/dev-shell.sh." >&2
        exit 1
    fi
done

FREETYPE_PREFIX="${WASM_POSIX_DEP_FREETYPE_DIR:?WASM_POSIX_DEP_FREETYPE_DIR not set (must be invoked via cargo xtask build-deps resolve fcft)}"
FONTCONFIG_PREFIX="${WASM_POSIX_DEP_FONTCONFIG_DIR:?WASM_POSIX_DEP_FONTCONFIG_DIR not set}"
PIXMAN_PREFIX="${WASM_POSIX_DEP_PIXMAN_DIR:?WASM_POSIX_DEP_PIXMAN_DIR not set}"
TLLIST_PREFIX="${WASM_POSIX_DEP_TLLIST_DIR:?WASM_POSIX_DEP_TLLIST_DIR not set}"

# --- Fetch + verify source ---
if [ ! -d "$SRC_DIR" ]; then
    echo "==> Downloading fcft $FCFT_VERSION..."
    TARBALL="/tmp/fcft-${FCFT_VERSION}.tar.gz"
    curl --retry 10 --retry-delay 5 --retry-max-time 300 --retry-all-errors -fsSL "$SOURCE_URL" -o "$TARBALL"
    if [ -n "$SOURCE_SHA256" ]; then
        echo "==> Verifying source sha256..."
        echo "$SOURCE_SHA256  $TARBALL" | shasum -a 256 -c -
    fi
    mkdir -p "$SRC_DIR"
    tar xzf "$TARBALL" -C "$SRC_DIR" --strip-components=1
    rm "$TARBALL"
fi

rm -rf "$BUILD_DIR"
# The resolver-created output directory is itself publication authority, so
# a recipe must populate that inode rather than delete and recreate it.
if [ -n "${WASM_POSIX_DEP_OUT_DIR:-}" ]; then
    if [ -n "$(find "$INSTALL_DIR" -mindepth 1 -print -quit)" ]; then
        echo "ERROR: fcft resolver output directory must start empty" >&2
        exit 1
    fi
else
    rm -rf "$INSTALL_DIR"
fi
mkdir -p "$BUILD_DIR/gen" "$INSTALL_DIR/lib/pkgconfig" "$INSTALL_DIR/include/fcft"

echo "==> Generating headers..."
LC_ALL=C sh "$SRC_DIR/generate-version.sh" "$FCFT_VERSION" "$SRC_DIR" "$BUILD_DIR/gen/version.h"
LC_ALL=C sh "$SRC_DIR/generate-unicode-precompose.sh" \
    "$SRC_DIR/unicode/UnicodeData.txt" "$BUILD_DIR/gen/unicode-compose-table.h"
python3 "$SRC_DIR/generate-emoji-data.py" \
    "$SRC_DIR/unicode/emoji-data.txt" "$BUILD_DIR/gen/emoji-data.h"

CFLAGS=(
    -O2 -fPIC -std=c11
    -D_GNU_SOURCE=200809L
    -DFCFT_EXPORT=
    "-I$SRC_DIR"
    "-I$BUILD_DIR/gen"
    "-I$FREETYPE_PREFIX/include/freetype2"
    "-I$FONTCONFIG_PREFIX/include"
    "-I$PIXMAN_PREFIX/include/pixman-1"
    "-I$TLLIST_PREFIX/include"
)

echo "==> Compiling fcft for wasm32..."
wasm32posix-cc -c "${CFLAGS[@]}" "$SRC_DIR/fcft.c" -o "$BUILD_DIR/fcft.o"
wasm32posix-cc -c "${CFLAGS[@]}" "$SRC_DIR/log.c" -o "$BUILD_DIR/log.o"
wasm32posix-ar rcs "$INSTALL_DIR/lib/libfcft.a" \
    "$BUILD_DIR/fcft.o" "$BUILD_DIR/log.o"

for h in fcft.h stride.h; do
    cp "$SRC_DIR/fcft/$h" "$INSTALL_DIR/include/fcft/$h"
done

cat > "$INSTALL_DIR/lib/pkgconfig/fcft.pc" <<EOF
prefix=$INSTALL_DIR
libdir=\${prefix}/lib
includedir=\${prefix}/include

Name: fcft
Description: Simple font loading and glyph rasterization library
Version: $FCFT_VERSION
Requires.private: fontconfig freetype2 pixman-1
Libs: -L\${libdir} -lfcft
Cflags: -I\${includedir}
EOF

echo "==> fcft build complete!"
ls -lh "$INSTALL_DIR/lib/libfcft.a"
