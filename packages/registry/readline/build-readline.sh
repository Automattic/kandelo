#!/usr/bin/env bash
#
# Build GNU readline (libreadline.a + libhistory.a) for
# wasm32-posix-kernel, linked against the ncurses package's libtinfow
# terminfo backend. Uses the SDK's wasm32posix-configure wrapper, which
# auto-loads sdk/config.site — the same path bash's vendored readline
# already builds through on this target.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"
# shellcheck source=/dev/null
source "$REPO_ROOT/scripts/package-build-roots.sh"
kandelo_package_prepare_build_roots "$SCRIPT_DIR" wasm32
WORK_DIR="$KANDELO_PACKAGE_WORK_DIR"
SRC_DIR="$WORK_DIR/readline-src"
INSTALL_DIR="${KANDELO_PACKAGE_OUT_DIR:-$WORK_DIR/readline-install}"

READLINE_VERSION="${WASM_POSIX_DEP_VERSION:-8.2}"
SOURCE_URL="${WASM_POSIX_DEP_SOURCE_URL:-https://ftp.gnu.org/gnu/readline/readline-${READLINE_VERSION}.tar.gz}"
SOURCE_SHA256="${WASM_POSIX_DEP_SOURCE_SHA256:-3feb7171f16a84ee82ca18a36d7b9be109a52c04f492a053331d7d1095007c35}"

# Worktree-local SDK on PATH (provides wasm32posix-configure/-cc/-ar).
# shellcheck source=/dev/null
source "$REPO_ROOT/sdk/activate.sh"
if ! command -v wasm32posix-configure &>/dev/null; then
    echo "ERROR: wasm32posix-configure not found after sourcing sdk/activate.sh." >&2
    exit 1
fi

# --- ncurses dependency: readline's termcap/terminfo backend (libtinfow) ---
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

# --- Stage the resolver-verified source. ---
if [ ! -d "$SRC_DIR" ]; then
    echo "==> Staging verified readline $READLINE_VERSION source..."
    kandelo_package_stage_verified_source readline "$SRC_DIR" \
        "${WASM_POSIX_DEP_SOURCE_DIR:-}" "$SOURCE_URL" "$SOURCE_SHA256" "$WORK_DIR"
fi

cd "$SRC_DIR"

# readline shares bash's autoconf machinery. `bash_cv_termcap_lib` selects
# the termcap backend without readline's runtime link-probe (which cannot run
# under wasm); the termios/tty/signal probes are preset by sdk/config.site.
export bash_cv_termcap_lib=libtinfow
export CPPFLAGS="-I$NCURSES_PREFIX/include"
export LDFLAGS="-L$NCURSES_PREFIX/lib"

if [ ! -f Makefile ]; then
    echo "==> Configuring readline for wasm32..."
    wasm32posix-configure \
        --prefix="$INSTALL_DIR" \
        --with-curses \
        --disable-shared \
        --disable-nls \
        2>&1 | tail -30
fi

echo "==> Building readline..."
make -j"$(sysctl -n hw.ncpu 2>/dev/null || nproc)" 2>&1 | tail -30

echo "==> Installing readline to $INSTALL_DIR..."
make install 2>&1 | tail -15

# --- Verify declared outputs ---
for f in \
    lib/libreadline.a \
    lib/libhistory.a \
    include/readline/readline.h \
    include/readline/history.h
do
    if [ ! -f "$INSTALL_DIR/$f" ]; then
        echo "ERROR: expected readline output missing: $f" >&2
        exit 1
    fi
done

echo "==> readline build complete!"
ls -lh "$INSTALL_DIR/lib/libreadline.a" "$INSTALL_DIR/lib/libhistory.a"
