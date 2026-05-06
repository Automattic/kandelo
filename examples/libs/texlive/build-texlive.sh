#!/usr/bin/env bash
set -euo pipefail

TEXLIVE_VERSION="${TEXLIVE_VERSION:-2025}"
# Exported so build-texlive-bundle.sh's tlnet-final URL pins to the
# same release as the source tarball below — keeps the engine and
# its texmf-dist macros from drifting across upstream rollovers.
export TEXLIVE_VERSION
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
    # Cap at 2 jobs on memory-constrained runners. pdftex0.c +
    # pdftexini.c each compile to ~1.5GB of gcc working set; -j4 on a
    # GHA standard runner (7GB RAM) triggers swap thrash and the
    # streaming-log heartbeat starves long enough that the runner
    # appears hung from outside (no output for >10 min). -j2 keeps
    # peak under 4GB and keeps logs flowing. Local dev with more cores
    # can override via JOBS=$(nproc).
    NPROC="${JOBS:-2}"
    echo "==> Host build: -j$NPROC"
    # TexLive's auto-recurse mechanism creates and builds its
    # sub-subdirs at make time, NOT at configure time. The build is
    # split across four steps:
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
    echo "==> Host build step 1/4: top-level all-local"
    make -j"$NPROC" all-local
    echo "==> Host build step 2/4: libs/ recurse + xpdf"
    make -C libs recurse
    make -C libs/xpdf -j"$NPROC"
    echo "==> Host build step 3/4: texk/ (kpathsea, ptexenc, web2c)"
    make -C texk -j"$NPROC"
    echo "==> Host build step 4/4: pdftex + otangle"
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

    # BUILDCC / BUILDCXX / BUILDCFLAGS / BUILDCPPFLAGS / BUILDLDFLAGS:
    # TeX Live's documented build-host compiler vars (README.2building
    # §4.6.1). KPSE_NATIVE_SUBDIRS (m4/kpse-common.m4) — invoked by
    # libs/gmp and texk/web2c for their host-helper subdirs — appends
    # `--host=$build CC='$BUILDCC' CFLAGS='$BUILDCFLAGS' ...` to the
    # recursed configure args when cross-compiling. With BUILDCC unset
    # this becomes `CC=''`, autoconf falls through to prefix detection
    # via `--host=x86_64-unknown-linux-gnu`, finds nix's unwrapped
    # `x86_64-unknown-linux-gnu-gcc` binary (which lacks the cc-wrapper
    # CRT/spec injection), and the link probe fails with "C compiler
    # cannot create executables". Pinning BUILDCC=cc routes the recurse
    # through the wrapped `cc` instead. (Autoconf-2.70 CC_FOR_BUILD is
    # a different mechanism — TeX Live doesn't read it, so setting it
    # here had no effect on the recurse.)
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
        BUILDCC=cc \
        BUILDCXX=c++ \
        BUILDCFLAGS=-O2 \
        BUILDCPPFLAGS= \
        BUILDLDFLAGS= \
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
    NPROC="${JOBS:-2}"
    echo "==> Cross build: -j$NPROC"

    # Pass AR/RANLIB on the command line so they override Makefile
    # assignments. xpdf's sub-configure ignores the top-level AR
    # setting and hardcodes native `ar`, which produces empty
    # archives for wasm object files.
    WASM_AR="AR=wasm32posix-ar RANLIB=wasm32posix-ranlib"

    echo "==> Cross build step 1/4: top-level recurse"
    make -j"$NPROC" $WASM_AR

    echo "==> Cross build step 2/4: texk/kpathsea"
    make -C texk/kpathsea -j"$NPROC" $WASM_AR
    echo "==> Cross build step 3/4: libs/xpdf"
    make -C libs/xpdf -j"$NPROC" $WASM_AR
    echo "==> Cross build step 4/4: texk/web2c pdftex"
    make -C texk/web2c pdftex -j"$NPROC" $WASM_AR
    cd "$REPO_ROOT"
fi

# ─── Phase 3: Output ──────────────────────────────────────────────
mkdir -p "$BIN_DIR"
cp "$CROSS_BUILD_DIR/texk/web2c/pdftex" "$BIN_DIR/pdftex.wasm"

echo "==> pdftex.wasm: $(du -h "$BIN_DIR/pdftex.wasm" | cut -f1)"

# ─── Phase 4: Runtime bundle ──────────────────────────────────────
# pdftex.wasm alone can't typeset anything — it needs a TeX Live
# distribution (texmf-dist macros, fonts, etc.) plus a precompiled
# latex.fmt. The bundle script installs a minimal TeX Live via
# install-tl, generates latex.fmt with our just-built host pdftex,
# and packs the selected files into a JSON manifest the demo loads
# at runtime.
#
# Built here (not just in the browser-side script) so the bundle
# ships inside the texlive package's tar.zst archive — same pattern
# as vim's runtime/ tree. archive_stage packs everything in the
# resolver scratch dir, so writing the JSON there is enough.
BUNDLE_FILE="$BIN_DIR/texlive-bundle.json"
echo "==> Building TeX Live distribution bundle..."
TEXLIVE_BUNDLE_OUT="$BUNDLE_FILE" \
    bash "$REPO_ROOT/examples/browser/scripts/build-texlive-bundle.sh"
echo "==> texlive-bundle.json: $(du -h "$BUNDLE_FILE" | cut -f1)"

echo "==> Done."

# Install into local-binaries/ so the resolver picks the freshly-built
# binaries over the fetched release. Two outputs: pdftex.wasm (the
# engine) + texlive-bundle.json (its runtime distribution).
source "$REPO_ROOT/scripts/install-local-binary.sh"
install_local_binary texlive "$BIN_DIR/pdftex.wasm"
install_local_binary texlive "$BIN_DIR/texlive-bundle.json"
