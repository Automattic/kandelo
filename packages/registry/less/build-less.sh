#!/usr/bin/env bash
set -euo pipefail

# Build less for wasm32-posix-kernel.
#
# Uses the SDK's wasm32posix-configure wrapper for cross-compilation.
# Output: packages/registry/less/bin/less.wasm
#
# less requires termcap functions (tgetent, tgetstr, etc.) which musl
# doesn't provide. Previously this built a stub libtermcap.a whose
# tgetent() always returned "not found" — that made every terminal look
# like a dumb teletype, so less could never do real full-screen paging
# (it always printed "WARNING: terminal is not fully functional").
#
# Instead, we link against ncurses's real termcap implementation
# (libtinfow.a, aka libtinfo.a), which vim already links and which has
# xterm-256color/xterm/vt100/dumb terminal entries compiled in via
# MKfallback.sh — no runtime /usr/share/terminfo needed. See
# packages/registry/vim/build-vim.sh for the same resolve pattern.

LESS_VERSION="${LESS_VERSION:-668}"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"
SRC_DIR="$SCRIPT_DIR/less-src"
BIN_DIR="$SCRIPT_DIR/bin"
SYSROOT="$REPO_ROOT/sysroot"

# --- Prerequisites ---
if ! command -v wasm32posix-cc &>/dev/null; then
    echo "ERROR: wasm32posix-cc not found. Run 'npm link' in sdk/ first." >&2
    exit 1
fi

if [ ! -f "$SYSROOT/lib/libc.a" ]; then
    echo "ERROR: sysroot not found. Run: bash build.sh && bash scripts/build-musl.sh" >&2
    exit 1
fi

export WASM_POSIX_SYSROOT="$SYSROOT"

# --- Resolve ncurses via the dep cache ---
# An env-var short-circuit lets a caller (e.g. another resolver run,
# or a wrapper script) pass the prefix in directly and skip the cargo
# invocation. Otherwise we ask the resolver to build-or-hit the cache.
# Matches packages/registry/vim/build-vim.sh:57-71.
NCURSES_PREFIX="${WASM_POSIX_DEP_NCURSES_DIR:-}"
if [ -z "$NCURSES_PREFIX" ]; then
    echo "==> Resolving ncurses via cargo xtask build-deps..."
    HOST_TARGET="$(rustc -vV | awk '/^host/ {print $2}')"
    NCURSES_PREFIX="$(cd "$REPO_ROOT" && cargo run -p xtask --target "$HOST_TARGET" --quiet -- build-deps resolve ncurses)"
fi
if [ ! -f "$NCURSES_PREFIX/lib/libtinfow.a" ]; then
    echo "ERROR: ncurses resolve returned '$NCURSES_PREFIX' but libtinfow.a missing" >&2
    exit 1
fi
echo "==> ncurses at $NCURSES_PREFIX"

NCURSES_CPPFLAGS="-I$NCURSES_PREFIX/include"
if [ -d "$NCURSES_PREFIX/include/ncursesw" ]; then
    NCURSES_CPPFLAGS="$NCURSES_CPPFLAGS -I$NCURSES_PREFIX/include/ncursesw"
fi

# --- Download less source ---
if [ ! -d "$SRC_DIR" ]; then
    echo "==> Downloading less $LESS_VERSION..."
    TARBALL="less-${LESS_VERSION}.tar.gz"
    DOWNLOAD_URLS=(
        "https://www.greenwoodsoftware.com/less/${TARBALL}"
        "https://ftp.gnu.org/gnu/less/${TARBALL}"
    )
    for URL in "${DOWNLOAD_URLS[@]}"; do
        if curl \
            --connect-timeout 20 \
            --retry 3 \
            --retry-delay 5 \
            --retry-max-time 120 \
            --retry-all-errors \
            -fsSL "$URL" \
            -o "/tmp/$TARBALL"
        then
            break
        fi
        rm -f "/tmp/$TARBALL"
    done
    if [ ! -f "/tmp/$TARBALL" ]; then
        echo "ERROR: failed to download $TARBALL from all configured mirrors" >&2
        exit 1
    fi
    mkdir -p "$SRC_DIR"
    tar xzf "/tmp/$TARBALL" -C "$SRC_DIR" --strip-components=1
    rm "/tmp/$TARBALL"
    echo "==> Source extracted to $SRC_DIR"
fi

cd "$SRC_DIR"

# --- Configure ---
if [ ! -f Makefile ]; then
    echo "==> Configuring less for wasm32..."

    # Cross-compilation values
    export ac_cv_func_malloc_0_nonnull=yes
    export ac_cv_func_realloc_0_nonnull=yes
    export ac_cv_func_calloc_0_nonnull=yes
    export ac_cv_func_strerror_r=yes
    export ac_cv_func_strerror_r_char_p=no
    export ac_cv_have_decl_strerror_r=yes

    # Wasm32 type sizes
    export ac_cv_sizeof_long=4
    export ac_cv_sizeof_long_long=8
    export ac_cv_sizeof_unsigned_long=4
    export ac_cv_sizeof_int=4
    export ac_cv_sizeof_size_t=4

    # Point configure at ncurses's real termcap implementation. Unlike
    # the old stub, we let configure's AC_CHECK_LIB tests actually
    # link against the ncurses libraries (a real cross-link, not an
    # executed probe) so it picks a genuine TERMLIBS. -ltinfow in
    # LDFLAGS guarantees tgetent/tgetstr/tgetnum/tgetflag/tputs/tgoto
    # resolve at the final link no matter which curses lib configure
    # settles on.
    export CPPFLAGS="$NCURSES_CPPFLAGS"
    export LDFLAGS="-L$NCURSES_PREFIX/lib -ltinfow"

    wasm32posix-configure \
        --with-regex=posix \
        2>&1 | tail -30

    echo "==> Configure complete."
fi

# --- Build ---
echo "==> Building less..."
make -j"$(sysctl -n hw.ncpu 2>/dev/null || nproc)" 2>&1 | tail -30

echo "==> Collecting binary..."
mkdir -p "$BIN_DIR"

if [ -f "$SRC_DIR/less" ]; then
    cp "$SRC_DIR/less" "$BIN_DIR/less.wasm"
    echo "==> Built less"
    ls -lh "$BIN_DIR/less.wasm"
else
    echo "ERROR: less binary not found after build" >&2
    exit 1
fi

echo ""
echo "==> less built successfully!"
echo "Binary: $BIN_DIR/less.wasm"

# Install into local-binaries/ so the resolver picks the freshly-built
# binary over the fetched release.
source "$REPO_ROOT/scripts/install-local-binary.sh"
[ -f "$SCRIPT_DIR/bin/less.wasm" ] && install_local_binary less "$SCRIPT_DIR/bin/less.wasm" || true
