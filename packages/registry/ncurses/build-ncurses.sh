#!/usr/bin/env bash
#
# Build ncurses 6.5 for wasm32-posix-kernel.
#
# Honors the dep-resolver build-script contract (see
# docs/package-management.md). When invoked via
# `cargo xtask build-deps resolve ncurses`, these env vars are set by
# the resolver and the build installs into the shared cache:
#
#     WASM_POSIX_DEP_OUT_DIR        # where the script must `make install`
#     WASM_POSIX_DEP_VERSION        # upstream version
#     WASM_POSIX_DEP_SOURCE_URL     # tarball URL
#     WASM_POSIX_DEP_SOURCE_SHA256  # expected sha256 of the tarball
#
# For ad-hoc / legacy invocation (`bash build-ncurses.sh`), the script
# falls back to the in-tree `ncurses-install/` layout.
#
# Produces libncursesw.a and libtinfow.a with compiled-in fallback
# terminal entries (xterm-256color, xterm, vt100, dumb), plus the
# standard ncurses terminal utilities as wasm program outputs. Consumers
# don't need a runtime terminfo database for the common demo terminals —
# ncurses resolves these names against the linked-in table.
#
# Host `tic` and `infocmp` are needed during the build to regenerate
# `fallback.c` from `terminfo.src`. They live under
# `$SCRIPT_DIR/ncurses-host-build/` and are not cached by the
# resolver (they're host binaries, not wasm artifacts).

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"
SRC_DIR="$SCRIPT_DIR/ncurses-src"

# --- Inputs from resolver, with legacy fallbacks ---
NCURSES_VERSION="${WASM_POSIX_DEP_VERSION:-${NCURSES_VERSION:-6.5}}"
INSTALL_DIR="${WASM_POSIX_DEP_OUT_DIR:-$SCRIPT_DIR/ncurses-install}"
SOURCE_URL="${WASM_POSIX_DEP_SOURCE_URL:-https://ftpmirror.gnu.org/gnu/ncurses/ncurses-${NCURSES_VERSION}.tar.gz}"
SOURCE_SHA256="${WASM_POSIX_DEP_SOURCE_SHA256:-}"

if ! command -v wasm32posix-cc &>/dev/null; then
    echo "ERROR: wasm32posix-cc not found. Run 'npm link' in sdk/ first." >&2
    exit 1
fi

# --- Fetch + verify source ---
if [ ! -d "$SRC_DIR" ]; then
    echo "==> Downloading ncurses $NCURSES_VERSION..."
    TARBALL="/tmp/ncurses-${NCURSES_VERSION}.tar.gz"
    curl --retry 10 --retry-delay 5 --retry-max-time 300 --retry-all-errors -fsSL "$SOURCE_URL" -o "$TARBALL"
    if [ -n "$SOURCE_SHA256" ]; then
        echo "==> Verifying source sha256..."
        echo "$SOURCE_SHA256  $TARBALL" | shasum -a 256 -c -
    else
        echo "==> (no SOURCE_SHA256 declared; skipping verification)"
    fi
    mkdir -p "$SRC_DIR"
    tar xzf "$TARBALL" -C "$SRC_DIR" --strip-components=1
    rm "$TARBALL"
    echo "==> Source extracted to $SRC_DIR"
fi

# --- Build host tic + infocmp once (needed to generate fallback.c) ---
HOST_BUILD_DIR="$SCRIPT_DIR/ncurses-host-build"
HOST_TIC="$HOST_BUILD_DIR/progs/tic"
HOST_INFOCMP="$HOST_BUILD_DIR/progs/infocmp"
if [ ! -f "$HOST_TIC" ] || [ ! -f "$HOST_INFOCMP" ]; then
    echo "==> Building host tic + infocmp..."
    mkdir -p "$HOST_BUILD_DIR"
    (
        cd "$HOST_BUILD_DIR"
        "$SRC_DIR/configure" \
            --without-cxx \
            --without-cxx-binding \
            --without-ada \
            --without-tests \
            --without-manpages \
            --with-termlib \
            --enable-pc-files=no \
            --with-pkg-config=no \
            2>&1 | tail -5
        # progs/ depends on include/ and ncurses/ being built first.
        make -j"$(sysctl -n hw.ncpu 2>/dev/null || nproc)" -C include 2>&1 | tail -5
        make -j"$(sysctl -n hw.ncpu 2>/dev/null || nproc)" -C ncurses 2>&1 | tail -5
        make -j"$(sysctl -n hw.ncpu 2>/dev/null || nproc)" -C progs tic infocmp 2>&1 | tail -10
    )
    echo "==> Host tic + infocmp built"
fi

# --- Compile minimal terminfo DB (build-time intermediate, not a declared output) ---
# Fed into MKfallback.sh below to produce the compiled-in fallback table.
TERMINFO_DIR="$SCRIPT_DIR/terminfo"
if [ ! -f "$TERMINFO_DIR/x/xterm-256color" ]; then
    echo "==> Compiling host-side terminfo database..."
    mkdir -p "$TERMINFO_DIR"
    TERMINFO="$TERMINFO_DIR" "$HOST_TIC" -x -e xterm-256color,xterm,vt100,dumb \
        "$SRC_DIR/misc/terminfo.src" 2>&1 | tail -5 || true
fi

# --- Cross-compile ncurses for wasm32 ---
# Always rebuild from a clean slate: INSTALL_DIR can differ between
# cache-miss invocations, and autoconf bakes the prefix into the
# Makefile, so reusing a stale wasm-build dir would `make install`
# into the wrong path.
WASM_BUILD_DIR="$SCRIPT_DIR/ncurses-wasm-build"
rm -rf "$WASM_BUILD_DIR" "$INSTALL_DIR"
mkdir -p "$WASM_BUILD_DIR"

echo "==> Configuring ncurses for wasm32..."

# configure feature probes that would otherwise try to run a wasm binary.
export cf_cv_func_mkstemp=yes
export cf_cv_func_nanosleep=yes
export cf_cv_link_funcs=no
export cf_cv_working_poll=yes
export cf_cv_func_poll=yes
export cf_cv_posix_saved_ids=yes

# Type sizes for wasm32.
export ac_cv_sizeof_signed_char=1
export ac_cv_sizeof_short=2
export ac_cv_sizeof_int=4
export ac_cv_sizeof_long=4
export ac_cv_sizeof_void_p=4

(
    cd "$WASM_BUILD_DIR"

    CC=wasm32posix-cc \
    CXX=wasm32posix-c++ \
    AR=wasm32posix-ar \
    RANLIB=wasm32posix-ranlib \
    LD=wasm32posix-cc \
    CFLAGS="-O2" \
    LDFLAGS="" \
    "$SRC_DIR/configure" \
        --host=wasm32-unknown-none \
        --prefix="$INSTALL_DIR" \
        --without-cxx \
        --without-cxx-binding \
        --without-ada \
        --without-tests \
        --without-manpages \
        --with-termlib \
        --without-debug \
        --without-profile \
        --without-shared \
        --with-normal \
        --disable-db-install \
        --with-default-terminfo-dir=/usr/share/terminfo \
        --with-terminfo-dirs=/usr/share/terminfo \
        --with-fallbacks=xterm-256color,xterm,vt100,dumb \
        --with-tic-path="$HOST_TIC" \
        --with-infocmp-path="$HOST_INFOCMP" \
        --enable-pc-files=no \
        --with-pkg-config=no \
        --disable-stripping \
        --enable-widec \
        2>&1 | tail -20

    # On Darwin hosts, ncurses' configure probes add `-dynamic` as the
    # counterpart to `-static` in generated program link flags. The
    # wasm32 SDK links static binaries and clang rejects both switches
    # together, so strip the host-only dynamic-mode flag.
    for makefile in progs/Makefile ncurses/Makefile; do
        if [ -f "$makefile" ]; then
            sed -i.bak 's/[[:space:]]-dynamic//g' "$makefile"
        fi
    done

    # The target utilities are statically linked, so the fallback table
    # must be present before `make` links clear/tput/etc. Generate it
    # with the host tic/infocmp configured above; the target tic cannot
    # run on the build host.
    echo "==> Generating fallback terminal entries..."
    TERMINFO_SRC="$SRC_DIR/misc/terminfo.src"
    MKFALLBACK="$SRC_DIR/ncurses/tinfo/MKfallback.sh"
    TERMINFO="$TERMINFO_DIR" bash -e "$MKFALLBACK" \
        "$TERMINFO_DIR" "$TERMINFO_SRC" "$HOST_TIC" "$HOST_INFOCMP" \
        xterm-256color xterm vt100 dumb \
        > ncurses/fallback.c 2>/dev/null

    echo "==> Building ncurses..."
    make -j"$(sysctl -n hw.ncpu 2>/dev/null || nproc)" 2>&1 | tail -20
)

echo "==> Fallback entries compiled into libtinfow.a"

# --- Install into $INSTALL_DIR ---
echo "==> Installing to $INSTALL_DIR..."
(
    cd "$WASM_BUILD_DIR"
    make install 2>&1 | tail -10
)

# Non-wide symlinks for consumers that link `-lncurses` / `-ltinfo`.
# Nice-to-have — the resolver only enforces the underlying wide files.
# Use explicit `if` blocks rather than `[ ... ] && cmd` at statement
# level, since the latter returns non-zero when the test is false and
# `set -e` can pick that up as a script failure.
(
    cd "$INSTALL_DIR/lib"
    if [ ! -e libncurses.a ]; then ln -sf libncursesw.a libncurses.a; fi
    if [ ! -e libtinfo.a   ]; then ln -sf libtinfow.a   libtinfo.a;   fi
)

# Convenience: symlink include/ncursesw → include/ncurses, and expose
# each header at top-level for programs that `#include <curses.h>`
# without the ncursesw prefix.
(
    cd "$INSTALL_DIR/include"
    if [ -d ncursesw ] && [ ! -e ncurses ]; then
        ln -sf ncursesw ncurses
    fi
    for h in ncursesw/*.h; do
        name="$(basename "$h")"
        if [ ! -e "$name" ]; then ln -sf "ncursesw/$name" "$name"; fi
    done
)

source_program_for() {
    case "$1" in
        reset) echo "tset" ;;
        captoinfo | infotocap) echo "tic" ;;
        *) echo "$1" ;;
    esac
}

# --- Collect ncurses utility program outputs ---
NCURSES_PROGRAMS=(
    clear
    reset
    tset
    tput
    tabs
    tic
    infocmp
    toe
    captoinfo
    infotocap
)
BIN_DIR="$SCRIPT_DIR/bin"
rm -rf "$BIN_DIR"
mkdir -p "$BIN_DIR"

for program in "${NCURSES_PROGRAMS[@]}"; do
    source_program="$(source_program_for "$program")"
    source_path="$INSTALL_DIR/bin/$source_program"
    if [ ! -f "$source_path" ]; then
        echo "ERROR: expected ncurses program not found: $source_path" >&2
        exit 1
    fi
    cp "$source_path" "$BIN_DIR/$program.wasm"
done

source "$REPO_ROOT/scripts/install-local-binary.sh"
for program in "${NCURSES_PROGRAMS[@]}"; do
    install_local_binary ncurses "$BIN_DIR/$program.wasm"
done

if [ -f "$INSTALL_DIR/lib/libncursesw.a" ] && [ -f "$INSTALL_DIR/lib/libtinfow.a" ]; then
    echo ""
    echo "==> ncurses $NCURSES_VERSION built successfully!"
    ls -lh "$INSTALL_DIR/lib/libncursesw.a" "$INSTALL_DIR/lib/libtinfow.a"
    ls -lh "$BIN_DIR"/*.wasm
else
    echo "ERROR: Build failed — expected libraries not found" >&2
    exit 1
fi
