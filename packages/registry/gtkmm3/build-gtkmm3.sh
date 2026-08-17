#!/usr/bin/env bash
#
# Build gtkmm 3.24.2 (libgtkmm-3.0.a + libgdkmm-3.0.a) for
# wasm32-posix-kernel.
#
# 3.24.2 is the last autotools release of the gtkmm-3.0 ABI series
# (3.24.3 moved to meson-only), so the port rides the standard
# configure cross-compile pattern. C++ TUs need -fwasm-exceptions (see
# build-glibmm.sh). The unix-print check passes because the gtk3
# package installs gtk+-unix-print-3.0.pc.
#
# Honors the dep-resolver build-script contract (see
# docs/package-management.md). When invoked via
# `cargo xtask build-deps resolve gtkmm3`, env vars are set by the
# resolver:
#
#     WASM_POSIX_DEP_OUT_DIR          # install prefix
#     WASM_POSIX_DEP_VERSION          # upstream version
#     WASM_POSIX_DEP_SOURCE_URL       # tarball URL
#     WASM_POSIX_DEP_SOURCE_SHA256    # expected sha256 of the tarball
#     WASM_POSIX_DEP_<DEP>_DIR        # one resolved prefix per depends_on
#                                       entry (gtk3, glibmm, cairomm,
#                                       pangomm, atkmm, gdk-pixbuf, atk,
#                                       pango, cairo, glib, harfbuzz,
#                                       libepoxy, fontconfig, freetype,
#                                       libsigcxx, libcxx)

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"
SYSROOT="$REPO_ROOT/sysroot"
SRC_DIR="$SCRIPT_DIR/gtkmm3-src"

GTKMM_VERSION="${WASM_POSIX_DEP_VERSION:-3.24.2}"
INSTALL_DIR="${WASM_POSIX_DEP_OUT_DIR:-$SCRIPT_DIR/gtkmm3-install}"
SOURCE_URL="${WASM_POSIX_DEP_SOURCE_URL:-https://download.gnome.org/sources/gtkmm/3.24/gtkmm-${GTKMM_VERSION}.tar.xz}"
SOURCE_SHA256="${WASM_POSIX_DEP_SOURCE_SHA256:-}"

BUILD_DIR="$SCRIPT_DIR/gtkmm3-build"

if ! command -v wasm32posix-c++ &>/dev/null; then
    echo "ERROR: wasm32posix-c++ not found. Enter scripts/dev-shell.sh." >&2
    exit 1
fi

GTK3_PREFIX="${WASM_POSIX_DEP_GTK3_DIR:?WASM_POSIX_DEP_GTK3_DIR not set (must be invoked via cargo xtask build-deps resolve gtkmm3)}"
GLIBMM_PREFIX="${WASM_POSIX_DEP_GLIBMM_DIR:?WASM_POSIX_DEP_GLIBMM_DIR not set}"
CAIROMM_PREFIX="${WASM_POSIX_DEP_CAIROMM_DIR:?WASM_POSIX_DEP_CAIROMM_DIR not set}"
PANGOMM_PREFIX="${WASM_POSIX_DEP_PANGOMM_DIR:?WASM_POSIX_DEP_PANGOMM_DIR not set}"
ATKMM_PREFIX="${WASM_POSIX_DEP_ATKMM_DIR:?WASM_POSIX_DEP_ATKMM_DIR not set}"
GDK_PIXBUF_PREFIX="${WASM_POSIX_DEP_GDK_PIXBUF_DIR:?WASM_POSIX_DEP_GDK_PIXBUF_DIR not set}"
ATK_PREFIX="${WASM_POSIX_DEP_ATK_DIR:?WASM_POSIX_DEP_ATK_DIR not set}"
PANGO_PREFIX="${WASM_POSIX_DEP_PANGO_DIR:?WASM_POSIX_DEP_PANGO_DIR not set}"
CAIRO_PREFIX="${WASM_POSIX_DEP_CAIRO_DIR:?WASM_POSIX_DEP_CAIRO_DIR not set}"
GLIB_PREFIX="${WASM_POSIX_DEP_GLIB_DIR:?WASM_POSIX_DEP_GLIB_DIR not set}"
HARFBUZZ_PREFIX="${WASM_POSIX_DEP_HARFBUZZ_DIR:?WASM_POSIX_DEP_HARFBUZZ_DIR not set}"
LIBEPOXY_PREFIX="${WASM_POSIX_DEP_LIBEPOXY_DIR:?WASM_POSIX_DEP_LIBEPOXY_DIR not set}"
FONTCONFIG_PREFIX="${WASM_POSIX_DEP_FONTCONFIG_DIR:?WASM_POSIX_DEP_FONTCONFIG_DIR not set}"
FREETYPE_PREFIX="${WASM_POSIX_DEP_FREETYPE_DIR:?WASM_POSIX_DEP_FREETYPE_DIR not set}"
LIBSIGCXX_PREFIX="${WASM_POSIX_DEP_LIBSIGCXX_DIR:?WASM_POSIX_DEP_LIBSIGCXX_DIR not set}"
LIBCXX_PREFIX="${WASM_POSIX_DEP_LIBCXX_DIR:?WASM_POSIX_DEP_LIBCXX_DIR not set}"

mkdir -p "$SYSROOT/lib" "$SYSROOT/include/c++"
ln -sf "$LIBCXX_PREFIX/lib/libc++.a"    "$SYSROOT/lib/libc++.a"
ln -sf "$LIBCXX_PREFIX/lib/libc++abi.a" "$SYSROOT/lib/libc++abi.a"
rm -rf "$SYSROOT/include/c++/v1"
ln -sfn "$LIBCXX_PREFIX/include/c++/v1" "$SYSROOT/include/c++/v1"

# --- Fetch + verify source ---
if [ ! -d "$SRC_DIR" ]; then
    echo "==> Downloading gtkmm $GTKMM_VERSION..."
    TARBALL="/tmp/gtkmm-${GTKMM_VERSION}.tar.xz"
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

# Fresh build dir each run — autoconf bakes --prefix into Makefiles.
rm -rf "$BUILD_DIR" "$INSTALL_DIR"
mkdir -p "$BUILD_DIR"

PC_PATH="$GTK3_PREFIX/lib/pkgconfig"
for prefix in "$GLIBMM_PREFIX" "$CAIROMM_PREFIX" "$PANGOMM_PREFIX" \
              "$ATKMM_PREFIX" "$GDK_PIXBUF_PREFIX" "$ATK_PREFIX" \
              "$PANGO_PREFIX" "$CAIRO_PREFIX" "$GLIB_PREFIX" \
              "$HARFBUZZ_PREFIX" "$LIBEPOXY_PREFIX" "$LIBSIGCXX_PREFIX"; do
    PC_PATH="$PC_PATH:$prefix/lib/pkgconfig"
done

echo "==> Configuring gtkmm for wasm32..."
(
    cd "$BUILD_DIR"
    # cairomm's headers pull cairo-ft.h; the host pkg-config does not
    # reliably traverse Requires.private for --cflags (see
    # build-cairomm.sh), so pass the freetype/fontconfig includes.
    CPPFLAGS="-I$FONTCONFIG_PREFIX/include -I$FREETYPE_PREFIX/include/freetype2" \
    CXXFLAGS="-O2 -fwasm-exceptions" \
    PKG_CONFIG_PATH="$PC_PATH" \
    "$SRC_DIR/configure" \
        --host=wasm32-unknown-none \
        --prefix="$INSTALL_DIR" \
        --enable-static \
        --disable-shared \
        --disable-documentation \
        CC=wasm32posix-cc \
        CXX=wasm32posix-c++ \
        AR=wasm32posix-ar \
        RANLIB=wasm32posix-ranlib

    echo "==> Building gtkmm..."
    make -j"$(sysctl -n hw.ncpu 2>/dev/null || nproc)" -C gdk/gdkmm
    make -j"$(sysctl -n hw.ncpu 2>/dev/null || nproc)" -C gtk/gtkmm

    echo "==> Installing to $INSTALL_DIR..."
    make -C gdk/gdkmm install
    make -C gtk/gtkmm install
    make install-data-am
)

for lib in libgtkmm-3.0.a libgdkmm-3.0.a; do
    if [ ! -f "$INSTALL_DIR/lib/$lib" ]; then
        echo "ERROR: Build failed — library not found at $INSTALL_DIR/lib/$lib" >&2
        exit 1
    fi
done

echo "==> gtkmm $GTKMM_VERSION build complete!"
ls -lh "$INSTALL_DIR/lib/"lib*mm-3.0.a
