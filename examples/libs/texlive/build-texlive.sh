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

# TeX Live always runs luajit's sub-configure even when all Lua engines are
# disabled. On macOS/ARM the luajit configure fails (can't find pow(), pointer
# size mismatch). Since we never build luajit, just remove the configure script
# so TeX Live's recursive make skips it entirely.
if [ -x "$SRC_DIR/libs/luajit/configure" ]; then
    chmod -x "$SRC_DIR/libs/luajit/configure"
fi

# ─── Phase 1: Host-native pdftex ──────────────────────────────────
if [ ! -x "$HOST_BUILD_DIR/texk/web2c/pdftex" ]; then
    echo "==> Building host-native pdftex..."
    mkdir -p "$HOST_BUILD_DIR"
    cd "$HOST_BUILD_DIR"

    "$SRC_DIR/configure" \
        --disable-all-pkgs \
        --enable-pdftex \
        --disable-synctex \
        --without-x \
        --disable-shared \
        --enable-static

    # --disable-all-pkgs prevents top-level make from recursing into
    # texk/web2c, so build targets explicitly in that subdir.
    # otangle is needed by cross-compile configure even though we don't
    # build Omega engines — web2c/configure unconditionally requires it.
    make -C texk/web2c pdftex otangle -j"$(sysctl -n hw.ncpu 2>/dev/null || nproc)"
    cd "$REPO_ROOT"
fi

HOST_PDFTEX="$HOST_BUILD_DIR/texk/web2c/pdftex"
echo "==> Host pdftex: $HOST_PDFTEX"

# ─── Phase 2: Cross-compile pdftex for wasm32 ─────────────────────
if [ ! -f "$CROSS_BUILD_DIR/texk/web2c/pdftex" ]; then
    echo "==> Cross-compiling pdftex for wasm32..."
    mkdir -p "$CROSS_BUILD_DIR"
    cd "$CROSS_BUILD_DIR"

    HOST_WEB2C="$HOST_BUILD_DIR/texk/web2c"

    # config.site for cross-compilation cache overrides.
    cat > config.site << 'SITE'
ac_cv_func_strerror_r=no
ac_cv_func_working_strerror_r=no
kpse_cv_have_decl_putenv=yes
kpse_cv_have_decl_getcwd=yes
enable_aleph=no
enable_xetex=no
enable_omfonts=no
SITE

    # Put host-built tangle/ctangle on PATH so sub-configures find them.

    # Export CONFIG_SITE so recursive sub-configures pick it up.
    export PATH="$HOST_WEB2C:$PATH"
    export CONFIG_SITE="$CROSS_BUILD_DIR/config.site"

    "$SRC_DIR/configure" \
        --host=wasm32-unknown-none \
        --build="$(cc -dumpmachine)" \
        --disable-all-pkgs \
        --enable-pdftex \
        --disable-native-texlive-build \
        --disable-aleph \
        --disable-xetex \
        --disable-omfonts \
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

    # --disable-all-pkgs leaves MAKE_SUBDIRS empty everywhere, but
    # CONF_SUBDIRS still lists all subdirectories. Running top-level
    # make triggers deferred configures for:
    #   - texk/kpathsea, texk/ptexenc (top-level CONF_SUBDIRS)
    #   - libs/xpdf, libs/zlib, etc. (libs/ CONF_SUBDIRS)
    #   - texk/web2c, etc. (texk/ CONF_SUBDIRS)
    # Without this, kpathsea and xpdf directories don't exist.
    NPROC="$(sysctl -n hw.ncpu 2>/dev/null || nproc)"

    # Pass AR/RANLIB on the command line so they override Makefile
    # assignments. xpdf's sub-configure ignores the top-level AR
    # setting and hardcodes native `ar`, which produces empty
    # archives for wasm object files.
    WASM_AR="AR=wasm32posix-ar RANLIB=wasm32posix-ranlib"

    make -j"$NPROC" $WASM_AR

    # Build pdftex's bundled dependencies before pdftex itself.
    make -C texk/kpathsea -j"$NPROC" $WASM_AR
    make -C libs/xpdf -j"$NPROC" $WASM_AR
    make -C texk/web2c pdftex -j"$NPROC" $WASM_AR
    cd "$REPO_ROOT"
fi

# ─── Phase 3: Output ──────────────────────────────────────────────
mkdir -p "$BIN_DIR"
cp "$CROSS_BUILD_DIR/texk/web2c/pdftex" "$BIN_DIR/pdftex.wasm"

echo "==> pdftex.wasm: $(du -h "$BIN_DIR/pdftex.wasm" | cut -f1)"
echo "==> Done."
