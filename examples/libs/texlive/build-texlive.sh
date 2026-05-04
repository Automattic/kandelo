#!/usr/bin/env bash
set -euo pipefail

TEXLIVE_VERSION="${TEXLIVE_VERSION:-2025}"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
SRC_DIR="$SCRIPT_DIR/texlive-src"
HOST_BUILD_DIR="$SCRIPT_DIR/texlive-host-build"
CROSS_BUILD_DIR="$SCRIPT_DIR/texlive-cross-build"
BIN_DIR="$SCRIPT_DIR/bin"

REPO_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"
# Worktree-local SDK on PATH (no global npm link required).
# shellcheck source=/dev/null
source "$REPO_ROOT/sdk/activate.sh"
# Explicit env wins; else the in-tree sysroot. Matches build-git.sh.
SYSROOT="${WASM_POSIX_SYSROOT:-$REPO_ROOT/sysroot}"
export WASM_POSIX_SYSROOT="$SYSROOT"

if ! command -v wasm32posix-cc &>/dev/null; then
    echo "ERROR: wasm32posix-cc not found after sourcing sdk/activate.sh." >&2
    exit 1
fi

# --- Resolve zlib + libpng via the dep cache ---
HOST_TARGET="$(rustc -vV | awk '/^host/ {print $2}')"
resolve_dep() {
    local name="$1"
    (cd "$REPO_ROOT" && cargo run -p xtask --target "$HOST_TARGET" --quiet -- build-deps resolve "$name")
}

ZLIB_PREFIX="${WASM_POSIX_DEP_ZLIB_DIR:-}"
if [ -z "$ZLIB_PREFIX" ]; then
    echo "==> Resolving zlib via cargo xtask build-deps..."
    ZLIB_PREFIX="$(resolve_dep zlib)"
fi
LIBPNG_PREFIX="${WASM_POSIX_DEP_LIBPNG_DIR:-}"
if [ -z "$LIBPNG_PREFIX" ]; then
    echo "==> Resolving libpng via cargo xtask build-deps..."
    LIBPNG_PREFIX="$(resolve_dep libpng)"
fi
if [ ! -f "$ZLIB_PREFIX/lib/libz.a" ]; then
    echo "ERROR: zlib resolve returned '$ZLIB_PREFIX' but libz.a missing" >&2
    exit 1
fi
if [ ! -f "$LIBPNG_PREFIX/lib/libpng.a" ] && [ ! -f "$LIBPNG_PREFIX/lib/libpng16.a" ]; then
    echo "ERROR: libpng resolve returned '$LIBPNG_PREFIX' but libpng[16].a missing" >&2
    exit 1
fi
echo "==> zlib at $ZLIB_PREFIX"
echo "==> libpng at $LIBPNG_PREFIX"

# Download TeX Live source
if [ ! -d "$SRC_DIR" ]; then
    echo "==> Downloading TeX Live $TEXLIVE_VERSION source..."
    TARBALL="texlive-${TEXLIVE_VERSION}0308-source.tar.xz"
    curl --retry 10 --retry-delay 5 --retry-max-time 300 --retry-all-errors -fsSL "https://ftp.math.utah.edu/pub/tex/historic/systems/texlive/${TEXLIVE_VERSION}/${TARBALL}" \
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

    # We only want pdftex. TexLive's web2c builds many other engines
    # by default (LuaTeX, XeTeX, MetaPost, Aleph, etc.) that pull in
    # heavy deps (LuaJIT, ICU, HarfBuzz). Each engine has its own
    # disable flag in web2c's configure; turning off the lot keeps the
    # build to xpdf + pdftex + their direct deps.
    "$SRC_DIR/configure" \
        --disable-all-pkgs \
        --enable-web2c \
        --enable-pdftex \
        --disable-luatex \
        --disable-luajittex \
        --disable-luahbtex \
        --disable-luajithbtex \
        --disable-xetex \
        --disable-aleph \
        --disable-euptex \
        --disable-hitex \
        --disable-mp \
        --disable-mflua \
        --disable-mfluajit \
        --disable-synctex \
        --without-x \
        --disable-shared \
        --enable-static

    # TexLive's subdirs are configured *at make time* via
    # `am/recurse.am`'s `recurse` target — `./configure` alone leaves
    # texk/web2c/ as a non-existent subdir.
    #
    # A naive `make all` at the top level would compile huge unused
    # libs (ICU, HarfBuzz, ...) before getting to texk/web2c. Instead,
    # build the chain explicitly: kpathsea + ptexenc (texk's TeX
    # libs), then run texk's recurse to create + build texk/web2c
    # (which makes pdftex; we add otangle since the cross-compile
    # configure unconditionally requires it even with Omega disabled).
    NPROC="$(sysctl -n hw.ncpu 2>/dev/null || nproc)"
    # TexLive's auto-recurse mechanism creates and builds its
    # sub-subdirs at make time, NOT at configure time. The build is
    # split across three steps:
    #
    # 1. `make all-local` at the top level: builds doc, texk/kpathsea,
    #    texk/ptexenc (which are top-level "TeX-specific lib" subdirs)
    #    AND fires the top-level recurse target which configures the
    #    immediate CONF_SUBDIRS (auxdir/auxsub, libs, utils, texk).
    # 2. `make -C libs recurse` configures libs's sub-subdirs (xpdf,
    #    zlib, etc.). pdftex needs libs/xpdf for its PDF parser; the
    #    --disable-all-pkgs --enable-pdftex combo keeps the other
    #    sub-subdirs (icu, harfbuzz, ...) skipped.
    # 3. `make -C texk` triggers texk's `all-local: recurse` which
    #    configures + builds texk/web2c (the only texk sub-subdir
    #    enabled by --enable-pdftex).
    # 4. Finally `make -C texk/web2c pdftex otangle` ensures otangle
    #    is built (the cross-compile configure unconditionally
    #    requires it even with Omega engines disabled).
    make -j"$NPROC" all-local
    make -C libs recurse
    make -C libs/xpdf -j"$NPROC"
    make -C texk -j"$NPROC"
    make -C texk/web2c -j"$NPROC" pdftex otangle
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

    # CC_FOR_BUILD: TeX Live's bundled GMP recursively configures a
    # `native/` subdir (a host-arch helper used during cross-compile).
    # That sub-configure forwards its parent's args and tacks on
    # `'CC=' 'CFLAGS=' '...'` to clear them, then re-detects via
    # `${build_alias}-gcc`. On Nix-CI that resolves to a wrapped
    # `x86_64-unknown-linux-gnu-gcc` whose required env (e.g. NIX_*
    # CRT/spec injections) gets stripped along with CFLAGS, so the
    # bare invocation can't link executables ("C compiler cannot
    # create executables"). Pinning CC_FOR_BUILD survives the recurse
    # because GMP's m4 macros consult it before falling back to host
    # detection.
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
        CC_FOR_BUILD=cc \
        CXX_FOR_BUILD=c++ \
        CFLAGS="-O2 -I$ZLIB_PREFIX/include -I$LIBPNG_PREFIX/include" \
        LDFLAGS="-L$ZLIB_PREFIX/lib -L$LIBPNG_PREFIX/lib" \
        ZLIB_CFLAGS="-I$ZLIB_PREFIX/include" \
        ZLIB_LIBS="-L$ZLIB_PREFIX/lib -lz" \
        LIBPNG_CFLAGS="-I$LIBPNG_PREFIX/include" \
        LIBPNG_LIBS="-L$LIBPNG_PREFIX/lib -lpng -lz"

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

# Install into local-binaries/ so the resolver picks the freshly-built
# binary over the fetched release.
source "$REPO_ROOT/scripts/install-local-binary.sh"
install_local_binary texlive "$BIN_DIR/pdftex.wasm" pdftex.wasm
