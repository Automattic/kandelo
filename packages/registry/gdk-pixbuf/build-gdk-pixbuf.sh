#!/usr/bin/env bash
#
# Build gdk-pixbuf 2.36.12 (libgdk_pixbuf-2.0.a) for wasm32-posix-kernel.
#
# 2.36.12 is the last autotools release (2.38 moved to meson), so the
# port rides the standard configure cross-compile pattern. Scope per
# plan §4 (PR24): the png loader only, compiled in statically — no
# jpeg/tiff, no dynamic loader modules.
#
# Honors the dep-resolver build-script contract (see
# docs/package-management.md). When invoked via
# `cargo xtask build-deps resolve gdk-pixbuf`, env vars are set by the
# resolver:
#
#     WASM_POSIX_DEP_OUT_DIR          # install prefix
#     WASM_POSIX_DEP_VERSION          # upstream version
#     WASM_POSIX_DEP_SOURCE_URL       # tarball URL
#     WASM_POSIX_DEP_SOURCE_SHA256    # expected sha256 of the tarball
#     WASM_POSIX_DEP_GLIB_DIR         # resolved glib prefix
#     WASM_POSIX_DEP_LIBPNG_DIR       # resolved libpng prefix

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
SRC_DIR="$SCRIPT_DIR/gdk-pixbuf-src"

GDK_PIXBUF_VERSION="${WASM_POSIX_DEP_VERSION:-2.36.12}"
INSTALL_DIR="${WASM_POSIX_DEP_OUT_DIR:-$SCRIPT_DIR/gdk-pixbuf-install}"
SOURCE_URL="${WASM_POSIX_DEP_SOURCE_URL:-https://download.gnome.org/sources/gdk-pixbuf/2.36/gdk-pixbuf-${GDK_PIXBUF_VERSION}.tar.xz}"
SOURCE_SHA256="${WASM_POSIX_DEP_SOURCE_SHA256:-}"

BUILD_DIR="$SCRIPT_DIR/gdk-pixbuf-build"

if ! command -v wasm32posix-cc &>/dev/null; then
    echo "ERROR: wasm32posix-cc not found. Enter scripts/dev-shell.sh." >&2
    exit 1
fi

GLIB_PREFIX="${WASM_POSIX_DEP_GLIB_DIR:?WASM_POSIX_DEP_GLIB_DIR not set (must be invoked via cargo xtask build-deps resolve gdk-pixbuf)}"
LIBPNG_PREFIX="${WASM_POSIX_DEP_LIBPNG_DIR:?WASM_POSIX_DEP_LIBPNG_DIR not set}"
LIBFFI_PREFIX="${WASM_POSIX_DEP_LIBFFI_DIR:?WASM_POSIX_DEP_LIBFFI_DIR not set}"
ZLIB_PREFIX="${WASM_POSIX_DEP_ZLIB_DIR:?WASM_POSIX_DEP_ZLIB_DIR not set}"

# --- Fetch + verify source ---
if [ ! -d "$SRC_DIR" ]; then
    echo "==> Downloading gdk-pixbuf $GDK_PIXBUF_VERSION..."
    TARBALL="/tmp/gdk-pixbuf-${GDK_PIXBUF_VERSION}.tar.xz"
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

PC_PATH="$GLIB_PREFIX/lib/pkgconfig:$LIBPNG_PREFIX/lib/pkgconfig"

echo "==> Configuring gdk-pixbuf for wasm32..."
(
    cd "$BUILD_DIR"
    # glib's pc files reference -lffi / -lz by bare name; the build's
    # own executables (timescale, gdk-pixbuf-csource) need the search
    # paths.
    CFLAGS="-O2" \
    LDFLAGS="-L$LIBFFI_PREFIX/lib -L$ZLIB_PREFIX/lib" \
    PKG_CONFIG_PATH="$PC_PATH" \
    gio_can_sniff=no \
    "$SRC_DIR/configure" \
        --host=wasm32-unknown-none \
        --prefix="$INSTALL_DIR" \
        --enable-static \
        --disable-shared \
        --disable-modules \
        --with-included-loaders=png \
        --without-libjpeg \
        --without-libtiff \
        --disable-glibtest \
        --enable-introspection=no \
        --disable-gtk-doc \
        --disable-nls \
        CC=wasm32posix-cc \
        AR=wasm32posix-ar \
        RANLIB=wasm32posix-ranlib

    echo "==> Building gdk-pixbuf..."
    make -j"$(sysctl -n hw.ncpu 2>/dev/null || nproc)" -C gdk-pixbuf

    echo "==> Installing to $INSTALL_DIR..."
    make -C gdk-pixbuf install
    make install-pkgconfigDATA
)

# The loaders are compiled in, so the query/csource tools (wasm
# binaries) have no consumer; drop them from the install tree.
rm -rf "$INSTALL_DIR/bin"

if [ -f "$INSTALL_DIR/lib/libgdk_pixbuf-2.0.a" ]; then
    echo "==> gdk-pixbuf build complete!"
    ls -lh "$INSTALL_DIR/lib/libgdk_pixbuf-2.0.a"
else
    echo "ERROR: Build failed — library not found at $INSTALL_DIR/lib/libgdk_pixbuf-2.0.a" >&2
    exit 1
fi
