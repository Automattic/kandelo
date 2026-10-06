#!/usr/bin/env bash
set -euo pipefail

# Build less for wasm32-posix-kernel.
#
# Uses the SDK's wasm32posix-configure wrapper for cross-compilation.
# Output: bin/less.wasm under the resolver work root (beside this script
# when run standalone).
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

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"
source "$REPO_ROOT/scripts/package-build-roots.sh"
kandelo_package_load_source_metadata "$SCRIPT_DIR"
source "$REPO_ROOT/sdk/activate.sh"
LESS_VERSION="$WASM_POSIX_DEP_VERSION"
# shellcheck source=/dev/null
# WHY: two resolves of this recipe can run at once in one checkout (two
# test files missing the cache together). Each keeps its source and build
# tree under its own resolver work root so neither deletes the other's.
# A standalone run keeps them beside this script.
kandelo_package_prepare_build_roots "$SCRIPT_DIR" wasm32
SRC_DIR="$KANDELO_PACKAGE_WORK_DIR/less-src"
BIN_DIR="$KANDELO_PACKAGE_WORK_DIR/bin"
SYSROOT="$REPO_ROOT/sysroot"

# A resolver caller owns the declared work and output roots. Keep the
# reviewed checkout read-only and suppress the developer-only local mirror.
if [ -n "${WASM_POSIX_DEP_WORK_DIR:-}" ] && [ -n "${WASM_POSIX_DEP_OUT_DIR:-}" ]; then
    export WASM_POSIX_INSTALL_LOCAL_MIRROR=0
    export WASM_POSIX_INSTALL_FORK_INSTRUMENTATION=auto
fi

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
kandelo_package_stage_primary_source less "$SRC_DIR" "$KANDELO_PACKAGE_WORK_DIR"

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
install_local_binary less "$BIN_DIR/less.wasm"
