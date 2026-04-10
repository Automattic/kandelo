#!/usr/bin/env bash
set -euo pipefail

# Build ncurses 6.5 for wasm32-posix-kernel.
#
# Produces libncurses.a and libtinfo.a (plus headers) installed into the
# sysroot. This enables TUI programs (vim, htop, tig, etc.) to use proper
# terminal capabilities instead of hardcoded ANSI fallbacks.
#
# Also compiles a minimal terminfo database (xterm-256color) so programs
# can look up terminal capabilities at runtime.

NCURSES_VERSION="${NCURSES_VERSION:-6.5}"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"
SRC_DIR="$SCRIPT_DIR/ncurses-src"
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

# --- Download ncurses source ---
if [ ! -d "$SRC_DIR" ]; then
    echo "==> Downloading ncurses $NCURSES_VERSION..."
    TARBALL="ncurses-${NCURSES_VERSION}.tar.gz"
    URL="https://ftp.gnu.org/gnu/ncurses/${TARBALL}"
    curl -fsSL "$URL" -o "/tmp/$TARBALL"
    mkdir -p "$SRC_DIR"
    tar xzf "/tmp/$TARBALL" -C "$SRC_DIR" --strip-components=1
    rm "/tmp/$TARBALL"
    echo "==> Source extracted to $SRC_DIR"
fi

# --- Build host tic first (needed to compile terminfo entries) ---
HOST_BUILD_DIR="$SCRIPT_DIR/ncurses-host-build"
HOST_TIC="$HOST_BUILD_DIR/progs/tic"
if [ ! -f "$HOST_TIC" ]; then
    echo "==> Building host tic..."
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
        # Must build include + ncurses lib before progs (progs depends on ../include/curses.h)
        make -j"$(sysctl -n hw.ncpu 2>/dev/null || nproc)" -C include 2>&1 | tail -5
        make -j"$(sysctl -n hw.ncpu 2>/dev/null || nproc)" -C ncurses 2>&1 | tail -5
        make -j"$(sysctl -n hw.ncpu 2>/dev/null || nproc)" -C progs tic infocmp 2>&1 | tail -10
    )
    echo "==> Host tic built: $HOST_TIC"
fi

# --- Cross-compile ncurses for wasm32 ---
WASM_BUILD_DIR="$SCRIPT_DIR/ncurses-wasm-build"
if [ ! -f "$WASM_BUILD_DIR/lib/libncurses.a" ]; then
    echo "==> Configuring ncurses for wasm32..."
    mkdir -p "$WASM_BUILD_DIR"

    # ncurses configure needs these for cross-compilation
    export cf_cv_func_mkstemp=yes
    export cf_cv_func_nanosleep=yes
    export cf_cv_link_funcs=no
    export cf_cv_working_poll=yes
    export cf_cv_func_poll=yes
    export cf_cv_posix_saved_ids=yes

    # Sizes for wasm32
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
            --prefix="$SYSROOT" \
            --without-cxx \
            --without-cxx-binding \
            --without-ada \
            --without-tests \
            --without-manpages \
            --without-progs \
            --with-termlib \
            --without-debug \
            --without-profile \
            --without-shared \
            --with-normal \
            --disable-database \
            --with-fallbacks=xterm-256color,xterm,vt100,dumb \
            --enable-pc-files=no \
            --with-pkg-config=no \
            --disable-stripping \
            --enable-widec \
            2>&1 | tail -20

        # Pre-populate fallback.c with a stub so make doesn't try to run
        # tic (which fails in cross-compilation). We regenerate it properly
        # after make using the host-built tic/infocmp.
        cat > ncurses/fallback.c <<'STUB'
#include <curses.priv.h>
NCURSES_EXPORT(const TERMTYPE2 *)
_nc_fallback2(const char *name GCC_UNUSED)
{ return (0); }
#if NCURSES_EXT_NUMBERS
NCURSES_EXPORT(const TERMTYPE *)
_nc_fallback(const char *name GCC_UNUSED)
{ return (0); }
#endif
STUB

        echo "==> Building ncurses..."
        make -j"$(sysctl -n hw.ncpu 2>/dev/null || nproc)" 2>&1 | tail -20
    )
    # Compile terminfo database using host tic (needed before fallback generation)
    TERMINFO_DIR="$SCRIPT_DIR/terminfo"
    if [ ! -f "$TERMINFO_DIR/x/xterm-256color" ]; then
        echo "==> Compiling terminfo database..."
        mkdir -p "$TERMINFO_DIR"
        TERMINFO="$TERMINFO_DIR" "$HOST_TIC" -x -e xterm-256color,xterm,vt100,dumb \
            "$SRC_DIR/misc/terminfo.src" 2>&1 | tail -5 || true
    fi

    # Regenerate fallback.c with host tic+infocmp — the cross-build can't
    # run tic to generate the compiled-in terminal entries, so fallback.c
    # ends up empty. We use the host-built tools to produce correct data.
    echo "==> Regenerating fallback terminal entries..."
    HOST_INFOCMP="$HOST_BUILD_DIR/progs/infocmp"
    TERMINFO_SRC="$SRC_DIR/misc/terminfo.src"
    MKFALLBACK="$SRC_DIR/ncurses/tinfo/MKfallback.sh"
    TERMINFO="$TERMINFO_DIR" bash -e "$MKFALLBACK" \
        "$TERMINFO_DIR" "$TERMINFO_SRC" "$HOST_TIC" "$HOST_INFOCMP" \
        xterm-256color xterm vt100 dumb \
        > "$WASM_BUILD_DIR/ncurses/fallback.c" 2>/dev/null

    # Recompile fallback.o and update the library
    (
        cd "$WASM_BUILD_DIR"
        wasm32posix-cc -I./ncurses -I./include -I"$SRC_DIR/ncurses" -I"$SRC_DIR/include" \
            -DHAVE_CONFIG_H -DNDEBUG -O2 -DNCURSES_STATIC -DUSE_TERMLIB \
            -c ncurses/fallback.c -o objects/fallback.o 2>&1 | grep -v warning || true
        wasm32posix-ar r lib/libtinfow.a objects/fallback.o 2>&1
        wasm32posix-ranlib lib/libtinfow.a
    )
    echo "==> Fallback entries compiled"

    echo "==> ncurses cross-compiled"
fi

# --- Install into sysroot ---
if [ ! -f "$SYSROOT/lib/libncursesw.a" ]; then
    echo "==> Installing ncurses into sysroot..."
    (
        cd "$WASM_BUILD_DIR"
        make install 2>&1 | tail -10
    )

    # Create non-wide symlinks for programs that don't use the wide variants
    (
        cd "$SYSROOT/lib"
        [ ! -f libncurses.a ] && ln -sf libncursesw.a libncurses.a
        [ ! -f libtinfo.a ] && ln -sf libtinfow.a libtinfo.a
    )
    (
        cd "$SYSROOT/include"
        if [ -d ncursesw ] && [ ! -d ncurses ]; then
            ln -sf ncursesw ncurses
        fi
        # Symlink headers to top-level include for programs expecting <curses.h>
        for h in ncursesw/*.h; do
            name="$(basename "$h")"
            [ ! -f "$name" ] && ln -sf "ncursesw/$name" "$name"
        done
    )

    echo "==> ncurses installed into sysroot"
fi

# --- Compile minimal terminfo database (if not already done above) ---
TERMINFO_DIR="${TERMINFO_DIR:-$SCRIPT_DIR/terminfo}"
if [ ! -f "$TERMINFO_DIR/x/xterm-256color" ]; then
    echo "==> Compiling terminfo database..."
    mkdir -p "$TERMINFO_DIR"

    # Use host tic to compile just the xterm-256color entry
    TERMINFO="$TERMINFO_DIR" "$HOST_TIC" -x -e xterm-256color,xterm,vt100,dumb \
        "$SRC_DIR/misc/terminfo.src" 2>&1 | tail -5 || true

    echo "==> Terminfo entries:"
    find "$TERMINFO_DIR" -type f | head -20
fi

echo ""
echo "==> ncurses $NCURSES_VERSION built successfully!"
echo "Libraries: $SYSROOT/lib/libncursesw.a, $SYSROOT/lib/libtinfow.a"
echo "Headers:   $SYSROOT/include/ncursesw/"
echo "Terminfo:  $TERMINFO_DIR/"
