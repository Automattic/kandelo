#!/usr/bin/env bash
set -euo pipefail

TEXLIVE_VERSION="${TEXLIVE_VERSION:-2025}"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
SRC_DIR="$SCRIPT_DIR/texlive-src"
HOST_BUILD_DIR="$SCRIPT_DIR/texlive-host-build"
CROSS_BUILD_DIR="$SCRIPT_DIR/texlive-cross-build"
BIN_DIR="$SCRIPT_DIR/bin"

REPO_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"
SYSROOT="$REPO_ROOT/sysroot"
export WASM_POSIX_SYSROOT="$SYSROOT"

if ! command -v wasm32posix-cc &>/dev/null; then
    echo "ERROR: wasm32posix-cc not found." >&2
    exit 1
fi

# Build libpng if needed
LIBPNG_DIR="$REPO_ROOT/examples/libs/libpng/libpng-install"
if [ ! -f "$LIBPNG_DIR/lib/libpng.a" ] && [ ! -f "$LIBPNG_DIR/lib/libpng16.a" ]; then
    echo "==> Building libpng..."
    bash "$REPO_ROOT/examples/libs/libpng/build-libpng.sh"
fi

# Install libpng into sysroot
echo "==> Installing libpng into sysroot..."
for f in png.h pngconf.h pnglibconf.h; do
    [ -f "$LIBPNG_DIR/include/$f" ] && cp "$LIBPNG_DIR/include/$f" "$SYSROOT/include/"
done
for f in libpng.a libpng16.a; do
    [ -f "$LIBPNG_DIR/lib/$f" ] && cp "$LIBPNG_DIR/lib/$f" "$SYSROOT/lib/"
done

# Download TeX Live source
if [ ! -d "$SRC_DIR" ]; then
    echo "==> Downloading TeX Live $TEXLIVE_VERSION source..."
    TARBALL="texlive-${TEXLIVE_VERSION}0308-source.tar.xz"
    curl -fsSL "https://ftp.math.utah.edu/pub/tex/historic/systems/texlive/${TEXLIVE_VERSION}/${TARBALL}" \
        -o "/tmp/${TARBALL}"
    mkdir -p "$SRC_DIR"
    tar xf "/tmp/${TARBALL}" -C "$SRC_DIR" --strip-components=1
    rm "/tmp/${TARBALL}"
fi

# ─── Phase 1: Host-native pdftex ──────────────────────────────────
if [ ! -x "$HOST_BUILD_DIR/texk/web2c/pdftex" ]; then
    echo "==> Building host-native pdftex..."
    mkdir -p "$HOST_BUILD_DIR"
    cd "$HOST_BUILD_DIR"

    "$SRC_DIR/configure" \
        --disable-all-pkgs \
        --enable-pdftex \
        --disable-luatex \
        --disable-luajittex \
        --disable-luahbtex \
        --disable-luajithbtex \
        --disable-mflua \
        --disable-mfluajit \
        --disable-synctex \
        --without-x \
        --disable-shared \
        --enable-static

    make -j"$(sysctl -n hw.ncpu 2>/dev/null || nproc)"
    cd "$REPO_ROOT"
fi

HOST_PDFTEX="$HOST_BUILD_DIR/texk/web2c/pdftex"
echo "==> Host pdftex: $HOST_PDFTEX"

# ─── Phase 2: Cross-compile pdftex for wasm32 ─────────────────────
if [ ! -f "$CROSS_BUILD_DIR/texk/web2c/pdftex" ]; then
    echo "==> Cross-compiling pdftex for wasm32..."
    mkdir -p "$CROSS_BUILD_DIR"
    cd "$CROSS_BUILD_DIR"

    # Create config.site for cross-compilation
    cat > config.site << 'SITE'
ac_cv_func_strerror_r=no
ac_cv_func_working_strerror_r=no
kpse_cv_have_decl_putenv=yes
kpse_cv_have_decl_getcwd=yes
SITE

    HOST_WEB2C="$HOST_BUILD_DIR/texk/web2c"

    CONFIG_SITE="$CROSS_BUILD_DIR/config.site" \
    TANGLEBOOT="$HOST_WEB2C/tangleboot" \
    CTANGLEBOOT="$HOST_WEB2C/ctangleboot" \
    TIEBOOT="$HOST_WEB2C/tieboot" \
    "$SRC_DIR/configure" \
        --host=wasm32-unknown-none \
        --build="$(cc -dumpmachine)" \
        --disable-all-pkgs \
        --enable-pdftex \
        --disable-luatex \
        --disable-luajittex \
        --disable-luahbtex \
        --disable-luajithbtex \
        --disable-mflua \
        --disable-mfluajit \
        --disable-synctex \
        --without-x \
        --disable-shared \
        --enable-static \
        --with-system-zlib \
        --with-system-libpng \
        CC=wasm32posix-cc \
        CXX=wasm32posix-c++ \
        AR=wasm32posix-ar \
        RANLIB=wasm32posix-ranlib \
        CFLAGS="-O2 -I$SYSROOT/include" \
        LDFLAGS="-L$SYSROOT/lib" \
        ZLIB_CFLAGS="-I$SYSROOT/include" \
        ZLIB_LIBS="-L$SYSROOT/lib -lz" \
        LIBPNG_CFLAGS="-I$SYSROOT/include" \
        LIBPNG_LIBS="-L$SYSROOT/lib -lpng -lz"

    make -j"$(sysctl -n hw.ncpu 2>/dev/null || nproc)"
    cd "$REPO_ROOT"
fi

# ─── Phase 3: Output ──────────────────────────────────────────────
mkdir -p "$BIN_DIR"
cp "$CROSS_BUILD_DIR/texk/web2c/pdftex" "$BIN_DIR/pdftex.wasm"

echo "==> pdftex.wasm: $(du -h "$BIN_DIR/pdftex.wasm" | cut -f1)"
echo "==> Done."
