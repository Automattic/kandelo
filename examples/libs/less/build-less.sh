#!/usr/bin/env bash
set -euo pipefail

# Build less 661 for wasm32-posix-kernel.
#
# Uses the SDK's wasm32posix-configure wrapper for cross-compilation.
# Output: examples/libs/less/bin/less.wasm
#
# less requires termcap functions (tgetent, tgetstr, etc.) which musl
# doesn't provide. We build a minimal stub library (termcap-stub.c) that
# returns "not found" — less then falls back to hardcoded ANSI sequences.
# We also provide a minimal termcap.h header.

LESS_VERSION="${LESS_VERSION:-661}"
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

# --- Build termcap stub library ---
TERMCAP_DIR="$SCRIPT_DIR/libtermcap"
if [ ! -f "$TERMCAP_DIR/libtermcap.a" ]; then
    echo "==> Building termcap stub library..."
    mkdir -p "$TERMCAP_DIR/include"
    cp "$SCRIPT_DIR/termcap.h" "$TERMCAP_DIR/include/termcap.h"
    wasm32posix-cc -I"$TERMCAP_DIR/include" -c "$SCRIPT_DIR/termcap-stub.c" -o "$TERMCAP_DIR/termcap-stub.o"
    wasm32posix-ar rcs "$TERMCAP_DIR/libtermcap.a" "$TERMCAP_DIR/termcap-stub.o"
    rm "$TERMCAP_DIR/termcap-stub.o"
    echo "==> termcap stub library built"
fi

# --- Download less source ---
if [ ! -d "$SRC_DIR" ]; then
    echo "==> Downloading less $LESS_VERSION..."
    TARBALL="less-${LESS_VERSION}.tar.gz"
    URL="https://www.greenwoodsoftware.com/less/${TARBALL}"
    curl --retry 10 --retry-delay 5 --retry-max-time 300 --retry-all-errors -fsSL "$URL" -o "/tmp/$TARBALL"
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

    # Tell configure our termcap.h exists and -ltermcap works.
    # Disable all other terminal library checks.
    export ac_cv_header_termcap_h=yes
    export ac_cv_lib_ncurses_initscr=no
    export ac_cv_lib_ncursesw_initscr=no
    export ac_cv_lib_tinfo_tgetent=no
    export ac_cv_lib_tinfow_tgetent=no
    export ac_cv_lib_xcurses_initscr=no
    export ac_cv_lib_curses_initscr=no
    export ac_cv_lib_curses_tgetent=no
    export ac_cv_lib_termlib_tgetent=no
    export ac_cv_lib_termcap_tgetent=yes

    # Include path for termcap.h, library path for libtermcap.a
    export CFLAGS="-I${TERMCAP_DIR}/include"
    export LDFLAGS="-L${TERMCAP_DIR}"
    export LIBS="-ltermcap"

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
