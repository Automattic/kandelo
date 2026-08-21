#!/usr/bin/env bash
#
# Build fontconfig (libfontconfig.a) for wasm32-posix-kernel.
#
# Honors the dep-resolver build-script contract (see
# docs/package-management.md). Autotools cross-build. The XML backend
# is libxml2 — already ported — instead of expat, which is not. The
# release tarball ships the generated fccase.h/fclang.h, so neither
# gperf nor python runs at build time.
#
# Runtime paths are baked at configure time: fonts under
# /usr/share/fonts, config under /etc/fonts, caches under
# /tmp/fontconfig (the only world-writable dir on this kernel — /var
# is a root-owned scratch mount). Consumers stage fonts.conf + a font
# into the VFS; without a cache fontconfig scans directories lazily,
# which is fine for the handful of staged fonts.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
SRC_DIR="$SCRIPT_DIR/fontconfig-src"

FONTCONFIG_VERSION="${WASM_POSIX_DEP_VERSION:-2.15.0}"
INSTALL_DIR="${WASM_POSIX_DEP_OUT_DIR:-$SCRIPT_DIR/fontconfig-install}"
SOURCE_URL="${WASM_POSIX_DEP_SOURCE_URL:-https://www.freedesktop.org/software/fontconfig/release/fontconfig-${FONTCONFIG_VERSION}.tar.xz}"
SOURCE_SHA256="${WASM_POSIX_DEP_SOURCE_SHA256:-}"

BUILD_DIR="$SCRIPT_DIR/fontconfig-build"

if ! command -v wasm32posix-cc &>/dev/null; then
    echo "ERROR: wasm32posix-cc not found. Enter scripts/dev-shell.sh." >&2
    exit 1
fi

FREETYPE_PREFIX="${WASM_POSIX_DEP_FREETYPE_DIR:?WASM_POSIX_DEP_FREETYPE_DIR not set (must be invoked via cargo xtask build-deps resolve fontconfig)}"
LIBXML2_PREFIX="${WASM_POSIX_DEP_LIBXML2_DIR:?WASM_POSIX_DEP_LIBXML2_DIR not set (must be invoked via cargo xtask build-deps resolve fontconfig)}"

# --- Fetch + verify source ---
if [ ! -d "$SRC_DIR" ]; then
    echo "==> Downloading fontconfig $FONTCONFIG_VERSION..."
    TARBALL="/tmp/fontconfig-${FONTCONFIG_VERSION}.tar.xz"
    curl --retry 10 --retry-delay 5 --retry-max-time 300 --retry-all-errors -fsSL "$SOURCE_URL" -o "$TARBALL"
    if [ -n "$SOURCE_SHA256" ]; then
        echo "==> Verifying source sha256..."
        echo "$SOURCE_SHA256  $TARBALL" | shasum -a 256 -c -
    fi
    mkdir -p "$SRC_DIR"
    tar xJf "$TARBALL" -C "$SRC_DIR" --strip-components=1
    rm "$TARBALL"
fi

rm -rf "$BUILD_DIR" "$INSTALL_DIR"
mkdir -p "$BUILD_DIR"

echo "==> Configuring fontconfig for wasm32 (freetype at $FREETYPE_PREFIX, libxml2 at $LIBXML2_PREFIX)..."
(
    cd "$BUILD_DIR"
    # random_r/initstate_r and getprogname are glibc/BSD-only (musl has
    # neither); fstatfs is off because fcstat's f_type branch is gated on
    # __linux__, which this toolchain does not define — remote-fs and
    # broken-mtime detection are meaningless on this kernel's VFS anyway.
    CFLAGS="-O2" \
    ac_cv_func_random_r=no \
    ac_cv_func_initstate_r=no \
    ac_cv_func_getprogname=no \
    ac_cv_func_getexecname=no \
    ac_cv_func_fstatfs=no \
    "$SRC_DIR/configure" \
        --host=wasm32-unknown-none \
        --prefix="$INSTALL_DIR" \
        --enable-static \
        --disable-shared \
        --disable-docs \
        --enable-libxml2 \
        --sysconfdir=/etc \
        --localstatedir=/var \
        --with-default-fonts=/usr/share/fonts \
        --with-cache-dir=/tmp/fontconfig \
        --with-baseconfigdir=/etc/fonts \
        --with-configdir=/etc/fonts/conf.d \
        CC=wasm32posix-cc \
        AR=wasm32posix-ar \
        RANLIB=wasm32posix-ranlib \
        PKG_CONFIG=wasm32posix-pkg-config \
        FREETYPE_CFLAGS="-I$FREETYPE_PREFIX/include/freetype2" \
        FREETYPE_LIBS="-L$FREETYPE_PREFIX/lib -lfreetype" \
        LIBXML2_CFLAGS="-I$LIBXML2_PREFIX/include" \
        LIBXML2_LIBS="-L$LIBXML2_PREFIX/lib -lxml2"

    echo "==> Building fontconfig (library only)..."
    make -j"$(sysctl -n hw.ncpu 2>/dev/null || nproc)" -C src

    echo "==> Installing to $INSTALL_DIR..."
    make -C src install
    make -C fontconfig install
    make install-pkgconfigDATA
)

if [ -f "$INSTALL_DIR/lib/libfontconfig.a" ]; then
    echo "==> fontconfig build complete!"
    ls -lh "$INSTALL_DIR/lib/libfontconfig.a"
else
    echo "ERROR: Build failed — library not found at $INSTALL_DIR/lib/libfontconfig.a" >&2
    exit 1
fi
