#!/usr/bin/env bash
set -euo pipefail

# Build NetHack 3.6.7 for wasm32-posix-kernel.
#
# NetHack's build has two distinct phases:
#
#   1. Host build: util/ produces code-generation tools
#      (makedefs, dgn_comp, lev_comp, dlb, recover) that run on the
#      *host* to emit generated headers (onames.h, pm.h, date.h,
#      vis_tab.c) and the dlb-packed data archive `nhdat`.
#
#   2. Cross build: src/ compiles the game binary with wasm32posix-cc,
#      linking against our ncurses.
#
# The util phase runs first with plain `cc`, then src/ is cleaned and
# rebuilt with the wasm toolchain. Everything util/ already produced
# (headers in include/, nhdat in dat/) is kept.
#
# Output:
#   examples/libs/nethack/bin/nethack.wasm
#   examples/libs/nethack/runtime/share/nethack/nhdat   (and symbols/license)

NETHACK_VERSION="${NETHACK_VERSION:-3.6.7}"
NETHACK_SHORT="367"  # Upstream tarballs drop the dots: "nethack-367-src.tgz"

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"
SRC_DIR="$SCRIPT_DIR/nethack-src"
BIN_DIR="$SCRIPT_DIR/bin"
RUNTIME_DIR="$SCRIPT_DIR/runtime"
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

# --- Resolve ncurses via the dep cache (provides libncursesw, libtinfow, ncursesw headers) ---
NCURSES_PREFIX="${WASM_POSIX_DEP_NCURSES_DIR:-}"
if [ -z "$NCURSES_PREFIX" ]; then
    echo "==> Resolving ncurses via cargo xtask build-deps..."
    HOST_TARGET="$(rustc -vV | awk '/^host/ {print $2}')"
    NCURSES_PREFIX="$(cd "$REPO_ROOT" && cargo run -p xtask --target "$HOST_TARGET" --quiet -- build-deps resolve ncurses)"
fi
if [ ! -f "$NCURSES_PREFIX/lib/libncursesw.a" ]; then
    echo "ERROR: ncurses resolve returned '$NCURSES_PREFIX' but libncursesw.a missing" >&2
    exit 1
fi
echo "==> ncurses at $NCURSES_PREFIX"
export CPPFLAGS="${CPPFLAGS:-} -I$NCURSES_PREFIX/include"
export LDFLAGS="${LDFLAGS:-} -L$NCURSES_PREFIX/lib"

# --- Download NetHack source ---
if [ ! -d "$SRC_DIR" ]; then
    echo "==> Downloading NetHack $NETHACK_VERSION..."
    TARBALL="nethack-${NETHACK_SHORT}-src.tgz"
    URL="https://www.nethack.org/download/${NETHACK_VERSION}/${TARBALL}"
    curl -fsSL "$URL" -o "/tmp/${TARBALL}"
    mkdir -p "$SRC_DIR"
    tar xzf "/tmp/${TARBALL}" -C "$SRC_DIR" --strip-components=1
    rm "/tmp/${TARBALL}"
    echo "==> Source extracted to $SRC_DIR"
fi

cd "$SRC_DIR"

# --- Setup ---
# setup.sh rewrites top-level Makefile and sub-Makefiles from the chosen
# hints file. hints/linux is the closest match to our musl-based target.
if [ ! -f Makefile.configured ]; then
    echo "==> Running sys/unix/setup.sh hints/linux..."
    (cd sys/unix && sh setup.sh hints/linux)
    touch Makefile.configured
fi

# --- Patch include/config.h ---
#
# We want CURSES_GRAPHICS enabled and external COMPRESS disabled. Leaving
# TTY_GRAPHICS on is harmless — NetHack picks the windowing system at
# runtime via `windowtype`, and leaving both compiled in gives the user
# a choice.
#
# SYSCF must be disabled in the header too: Makefile hints leave it off,
# but config.h `#ifndef SYSCF` then re-enables it and hard-codes an
# SYSCF_FILE path the binary must open at startup. Our shell-demo build
# is single-user with no sysconf.
CONFIG_H="include/config.h"
if [ -f "$CONFIG_H" ] && ! grep -q "wasm32posix patch" "$CONFIG_H"; then
    echo "==> Patching include/config.h..."

    # Enable curses interface.
    sed -i.bak -E 's|^/\* *#define CURSES_GRAPHICS *\*/|#define CURSES_GRAPHICS|' \
        "$CONFIG_H"

    # Disable external COMPRESS calls — we ship nhdat pre-packed by DLB.
    sed -i.bak -E \
        -e 's|^#define COMPRESS .*|/* COMPRESS disabled for wasm32 */|' \
        -e 's|^#define COMPRESS_EXTENSION .*|/* COMPRESS_EXTENSION disabled */|' \
        "$CONFIG_H"

    # Disable SYSCF global-configuration machinery.
    sed -i.bak -E \
        -e 's|^#define SYSCF *$|/* SYSCF disabled for wasm32 */|' \
        -e 's|^#define SYSCF *(/\*.*\*/)?$|/* SYSCF disabled for wasm32 */|' \
        -e 's|^#define SYSCF_FILE .*|/* SYSCF_FILE disabled for wasm32 */|' \
        "$CONFIG_H"

    echo "/* wasm32posix patch */" >> "$CONFIG_H"
    rm -f "$CONFIG_H.bak"
fi

# --- Patch include/unixconf.h ---
#
# Override HACKDIR and add VAR_PLAYGROUND so read-only data lives under
# /usr/share/nethack and writable saves/scores under /home/.nethack.
UNIXCONF_H="include/unixconf.h"
if [ -f "$UNIXCONF_H" ] && ! grep -q "wasm32posix patch" "$UNIXCONF_H"; then
    echo "==> Patching include/unixconf.h..."

    sed -i.bak -E \
        -e 's|^#define HACKDIR.*|/* HACKDIR overridden below */|' \
        -e 's|^#define VAR_PLAYGROUND.*|/* VAR_PLAYGROUND overridden below */|' \
        "$UNIXCONF_H"

    cat >> "$UNIXCONF_H" <<'EOF'

/* wasm32posix patch */
#define HACKDIR "/usr/share/nethack"
#define VAR_PLAYGROUND "/home/.nethack"
EOF
    rm -f "$UNIXCONF_H.bak"
fi

# --- Patch include/global.h ---
#
# `struct version_info` is written to data files by host-built dgn_comp
# / lev_comp / dlb and read back by the cross-built game binary. It uses
# `unsigned long` which is 8 bytes on macOS/Linux hosts but 4 bytes on
# wasm32. The 40-byte file header gets read as a 20-byte struct and
# check_version() reports "Dungeon description not valid" even though
# the values are correct — the serialization is just off. Pin the
# fields to `uint32_t` so the layout is identical on host and target.
#
# `struct savefile_info` has the same hazard for save files; patch it
# the same way for consistency.
GLOBAL_H="include/global.h"
if [ -f "$GLOBAL_H" ] && ! grep -q "wasm32posix patch" "$GLOBAL_H"; then
    echo "==> Patching include/global.h (portable version_info)..."
    awk '
        /^struct version_info \{/ || /^struct savefile_info \{/ { in_struct=1 }
        in_struct && /unsigned long/ { gsub("unsigned long", "uint32_t      ") }
        /^\};/ && in_struct { in_struct=0 }
        { print }
    ' "$GLOBAL_H" > "$GLOBAL_H.new"
    # Ensure stdint.h is visible; global.h already pulls in config.h which
    # eventually reaches stdint. Add an explicit include to be safe.
    if ! grep -q '^#include <stdint.h>' "$GLOBAL_H.new"; then
        awk 'NR==1 && /^\/\* NetHack/ { print; print "#include <stdint.h>"; next } { print }' "$GLOBAL_H.new" > "$GLOBAL_H.new2"
        mv "$GLOBAL_H.new2" "$GLOBAL_H.new"
    fi
    mv "$GLOBAL_H.new" "$GLOBAL_H"
    echo "/* wasm32posix patch */" >> "$GLOBAL_H"
fi

# --- Patch include/tradstdc.h ---
#
# NetHack defines `warn_unused_result` to empty on non-Linux hosts to
# suppress GCC's warn_unused_result attribute. This breaks macOS SDK
# headers because sys/cdefs.h does `#if __has_attribute(warn_unused_result)`:
# once the token is a (empty) macro, it expands to nothing, and
# __has_attribute() trips on the missing argument. Stub the empty
# defines out — we never enable -Werror on host compiles and the
# downstream wasm cross build targets musl, not macOS.
TRADSTDC_H="include/tradstdc.h"
if [ -f "$TRADSTDC_H" ] && ! grep -q "wasm32posix patch" "$TRADSTDC_H"; then
    echo "==> Patching include/tradstdc.h..."

    sed -i.bak -E \
        -e 's|^#define __warn_unused_result__.*|/* __warn_unused_result__ empty-define suppressed for macOS SDK compatibility */|' \
        -e 's|^#define warn_unused_result.*|/* warn_unused_result empty-define suppressed for macOS SDK compatibility */|' \
        "$TRADSTDC_H"

    echo "/* wasm32posix patch */" >> "$TRADSTDC_H"
    rm -f "$TRADSTDC_H.bak"
fi

# --- Patch src/Makefile for ncursesw + include path ---
#
# src/Makefile was generated by setup.sh (populated from sys/unix/hints/linux
# + Makefile.src). It hardcodes:
#   WINTTYLIB=-lncurses -ltinfo
#   WINCURSESLIB=-lncurses
# Our sysroot ships the wide-character flavor (libncursesw, libtinfow),
# matching vim's build. We also need to teach the compiler where to find
# the ncursesw headers, which are under $SYSROOT/include/ncursesw.
SRC_MAKEFILE="src/Makefile"
if [ -f "$SRC_MAKEFILE" ] && ! grep -q "wasm32posix patch" "$SRC_MAKEFILE"; then
    echo "==> Patching src/Makefile..."

    sed -i.bak -E \
        -e 's|^WINTTYLIB *=.*|WINTTYLIB=-lncursesw -ltinfow|' \
        -e 's|^WINCURSESLIB *=.*|WINCURSESLIB=-lncursesw -ltinfow|' \
        "$SRC_MAKEFILE"

    # Drop -DSYSCF and -DSECURE. Those enable the multi-user / setuid-games
    # mode that expects a sysconf file under HACKDIR; we ship a single-user
    # shell-demo build where /usr/share/nethack is read-only and there is
    # no sysconf file to consult.
    sed -i.bak -E \
        -e 's|^CFLAGS\+=-DSYSCF -DSYSCF_FILE=.*|# -DSYSCF disabled for wasm32 single-user build|' \
        -e 's|^CFLAGS\+=-DCONFIG_ERROR_SECURE=.*|# -DCONFIG_ERROR_SECURE disabled for wasm32|' \
        "$SRC_MAKEFILE"

    # Append an additional CFLAGS line after the hints-supplied block so
    # ncursesw (from the resolver cache) and sysroot headers resolve when
    # cross-compiling. The hints set LFLAGS=-rdynamic with `=` (not `+=`)
    # later in the Makefile, which would clobber a `LFLAGS+=...` that
    # appeared earlier — so rewrite `LFLAGS=-rdynamic` to `LFLAGS+=...`
    # that prepends our `-L` to whatever was set previously.
    awk -v ncurses="$NCURSES_PREFIX" -v sysroot="$SYSROOT" '
        /^CFLAGS\+=-DCURSES_GRAPHICS/ {
            print;
            print "CFLAGS+=-I" ncurses "/include/ncursesw -I" ncurses "/include -I" sysroot "/include";
            print "LFLAGS+=-L" ncurses "/lib";
            next;
        }
        /^LFLAGS=-rdynamic$/ {
            print "LFLAGS+=-rdynamic -L" ncurses "/lib";
            next;
        }
        { print }
    ' "$SRC_MAKEFILE" > "$SRC_MAKEFILE.new" && mv "$SRC_MAKEFILE.new" "$SRC_MAKEFILE"

    echo "# wasm32posix patch" >> "$SRC_MAKEFILE"
    rm -f "$SRC_MAKEFILE.bak"
fi

# --- Phase 1: host build of util tools + data generation ---
#
# Build only the code-generation tools and data files. We deliberately
# avoid the top-level `all` / `update` targets because they'd build the
# game binary with host CC — wasted work, since phase 2 rebuilds it
# with wasm32posix-cc.
if [ ! -f "$SRC_DIR/dat/nhdat" ]; then
    echo "==> Host phase: building util tools..."
    # `$(MAKE)` in top-level Makefile recurses with no CC override; the
    # Linux hints default is gcc, which we override on the command line.
    # On macOS cc=clang works for these tools.
    make CC=cc LD=cc -C util makedefs dgn_comp lev_comp dlb recover 2>&1 | tail -20

    echo "==> Host phase: generating data files (dat/)..."
    # dat/Makefile's `all` builds $(VARDAT) + spec_levs + quest_levs + dungeon
    # using the tools built above. No CC needed — these are data files.
    make CC=cc LD=cc -C dat all 2>&1 | tail -20

    echo "==> Host phase: packing nhdat via dlb..."
    # Top-level `make dlb` runs dlb in dat/ to produce nhdat.
    make CC=cc LD=cc dlb 2>&1 | tail -10

    if [ ! -f "$SRC_DIR/dat/nhdat" ]; then
        echo "ERROR: dat/nhdat not produced by host build" >&2
        exit 1
    fi
fi

# --- Phase 2: cross build of src/nethack ---
#
# util/makedefs (and friends) are linked against ../src/monst.o and
# ../src/objects.o. `make -C src clean` removes those .o files; the next
# `make -C src` rebuilds them with the wasm toolchain, and make would
# then consider util/makedefs stale and relink it with wasm CC too,
# breaking future host-side regenerations.
#
# Future-date the host-built util binaries and generated headers so
# nothing below them looks stale, regardless of what happens to src/*.o.
echo "==> Cross phase: locking host artifacts..."
touch -t 204001010101 \
    util/makedefs util/dgn_comp util/lev_comp util/dlb util/recover \
    include/onames.h include/pm.h include/date.h include/vis_tab.h \
    dat/nhdat 2>/dev/null || true

echo "==> Cross phase: building nethack binary..."
make -C src clean 2>&1 | tail -5 || true

# Pass CC/LD/AR/RANLIB via command line; DO NOT override CFLAGS — the
# Makefile already has the right include paths and defines for this
# port after the src/Makefile patch above.
make -C src \
    CC=wasm32posix-cc \
    LINK=wasm32posix-cc \
    AR=wasm32posix-ar \
    RANLIB=wasm32posix-ranlib \
    nethack 2>&1 | tail -30

if [ ! -f "$SRC_DIR/src/nethack" ]; then
    echo "ERROR: src/nethack binary not produced" >&2
    exit 1
fi

# --- Stage outputs ---
echo "==> Staging outputs..."

mkdir -p "$BIN_DIR"
cp "$SRC_DIR/src/nethack" "$BIN_DIR/nethack.wasm"

# Install into local-binaries/ (resolver priority 1) and the resolver
# scratch dir when invoked by xtask build-deps / stage-release.
source "$REPO_ROOT/scripts/install-local-binary.sh"
install_local_binary nethack "$BIN_DIR/nethack.wasm"

mkdir -p "$RUNTIME_DIR/share/nethack"
cp "$SRC_DIR/dat/nhdat" "$RUNTIME_DIR/share/nethack/nhdat"
[ -f "$SRC_DIR/dat/symbols" ] && cp "$SRC_DIR/dat/symbols" "$RUNTIME_DIR/share/nethack/symbols"
[ -f "$SRC_DIR/dat/license" ] && cp "$SRC_DIR/dat/license" "$RUNTIME_DIR/share/nethack/license"

SIZE=$(wc -c < "$BIN_DIR/nethack.wasm" | tr -d ' ')
echo "==> Final size: $(echo "$SIZE" | numfmt --to=iec 2>/dev/null || echo "${SIZE} bytes")"

echo ""
echo "==> NetHack $NETHACK_VERSION built successfully!"
echo "Binary:  $BIN_DIR/nethack.wasm"
echo "Runtime: $RUNTIME_DIR/share/nethack/"
