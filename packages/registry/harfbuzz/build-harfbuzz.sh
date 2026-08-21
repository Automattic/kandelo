#!/usr/bin/env bash
#
# Build harfbuzz (libharfbuzz.a) for wasm32-posix-kernel.
#
# Upstream builds with meson only; the dist tarball ships a single-TU
# amalgam (src/harfbuzz.cc) intended for exactly this kind of embed,
# so the port compiles that one TU with the freetype backend and
# installs the public headers by hand. hb-features.h is
# meson-generated and no public header includes it, so it is not
# installed.
#
# Honors the dep-resolver build-script contract (see
# docs/package-management.md). When invoked via
# `cargo xtask build-deps resolve harfbuzz`, env vars are set by the
# resolver:
#
#     WASM_POSIX_DEP_OUT_DIR         # install prefix
#     WASM_POSIX_DEP_VERSION         # upstream version
#     WASM_POSIX_DEP_SOURCE_URL      # tarball URL
#     WASM_POSIX_DEP_SOURCE_SHA256   # expected sha256 of the tarball
#     WASM_POSIX_DEP_FREETYPE_DIR    # resolved freetype prefix
#     WASM_POSIX_DEP_GLIB_DIR        # resolved glib prefix

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
SRC_DIR="$SCRIPT_DIR/harfbuzz-src"

HARFBUZZ_VERSION="${WASM_POSIX_DEP_VERSION:-10.1.0}"
INSTALL_DIR="${WASM_POSIX_DEP_OUT_DIR:-$SCRIPT_DIR/harfbuzz-install}"
SOURCE_URL="${WASM_POSIX_DEP_SOURCE_URL:-https://github.com/harfbuzz/harfbuzz/releases/download/${HARFBUZZ_VERSION}/harfbuzz-${HARFBUZZ_VERSION}.tar.xz}"
SOURCE_SHA256="${WASM_POSIX_DEP_SOURCE_SHA256:-}"

BUILD_DIR="$SCRIPT_DIR/harfbuzz-build"

if ! command -v wasm32posix-c++ &>/dev/null; then
    echo "ERROR: wasm32posix-c++ not found. Enter scripts/dev-shell.sh." >&2
    exit 1
fi

FREETYPE_PREFIX="${WASM_POSIX_DEP_FREETYPE_DIR:?WASM_POSIX_DEP_FREETYPE_DIR not set (must be invoked via cargo xtask build-deps resolve harfbuzz)}"
GLIB_PREFIX="${WASM_POSIX_DEP_GLIB_DIR:?WASM_POSIX_DEP_GLIB_DIR not set}"

# --- Fetch + verify source ---
if [ ! -d "$SRC_DIR" ]; then
    echo "==> Downloading harfbuzz $HARFBUZZ_VERSION..."
    TARBALL="/tmp/harfbuzz-${HARFBUZZ_VERSION}.tar.xz"
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

rm -rf "$BUILD_DIR" "$INSTALL_DIR"
mkdir -p "$BUILD_DIR" "$INSTALL_DIR/lib/pkgconfig" "$INSTALL_DIR/include/harfbuzz"

echo "==> Compiling harfbuzz amalgam (freetype at $FREETYPE_PREFIX)..."
wasm32posix-c++ -O2 \
    -DHAVE_FREETYPE=1 \
    -DHAVE_GLIB=1 \
    -I"$FREETYPE_PREFIX/include/freetype2" \
    -I"$GLIB_PREFIX/include/glib-2.0" \
    -c "$SRC_DIR/src/harfbuzz.cc" -o "$BUILD_DIR/harfbuzz.o"

wasm32posix-ar rcs "$INSTALL_DIR/lib/libharfbuzz.a" "$BUILD_DIR/harfbuzz.o"
wasm32posix-ranlib "$INSTALL_DIR/lib/libharfbuzz.a"

echo "==> Installing headers..."
# The public header set meson installs for this configuration: the
# core hb-*.h list plus hb-ft.h and hb-glib.h, minus the backends
# this port does not compile (cairo, coretext, directwrite, gdi,
# gobject, graphite2, icu, uniscribe, wasm) and minus subset (a
# separate amalgam TU that nothing here consumes).
for h in hb.h hb-aat.h hb-aat-layout.h hb-blob.h hb-buffer.h \
         hb-common.h hb-deprecated.h hb-draw.h hb-face.h hb-font.h \
         hb-ft.h hb-glib.h hb-map.h hb-ot.h hb-ot-color.h hb-ot-deprecated.h \
         hb-ot-font.h hb-ot-layout.h hb-ot-math.h hb-ot-meta.h \
         hb-ot-metrics.h hb-ot-name.h hb-ot-shape.h hb-ot-var.h \
         hb-paint.h hb-set.h hb-shape.h hb-shape-plan.h hb-style.h \
         hb-unicode.h hb-version.h; do
    cp "$SRC_DIR/src/$h" "$INSTALL_DIR/include/harfbuzz/"
done

cat > "$INSTALL_DIR/lib/pkgconfig/harfbuzz.pc" <<EOF
prefix=$INSTALL_DIR
libdir=\${prefix}/lib
includedir=\${prefix}/include

Name: harfbuzz
Description: harfbuzz for wasm32-posix-kernel (static, freetype backend)
Version: $HARFBUZZ_VERSION
Libs: -L\${libdir} -lharfbuzz
Cflags: -I\${includedir}/harfbuzz
Requires.private: freetype2, glib-2.0
EOF

echo "==> harfbuzz $HARFBUZZ_VERSION build complete!"
ls -lh "$INSTALL_DIR/lib/libharfbuzz.a"
