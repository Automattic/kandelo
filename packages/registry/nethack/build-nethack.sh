#!/usr/bin/env bash
set -euo pipefail

# Build NetHack 3.6.7 for Kandelo, inside a Kandelo machine.
#
# NetHack's build compiles generators (util/makedefs, dgn_comp, lev_comp,
# dlb) and runs them to write headers (onames.h, pm.h, date.h, vis_tab.c)
# and the packed data archive `nhdat`, then compiles the game. Run on the
# build machine, those generators described the build machine: its OS in
# the banner, and 8-byte `long` fields in data files the 32-bit game reads
# as 4 bytes. So the whole build runs inside a Kandelo build machine
# (scripts/guest-build.sh) with the guest compiler, and the generators run
# on the target the game runs on.
#
# This script, on the build machine, stages the verified source, applies the
# target patches, runs upstream's setup.sh, and hands the tree to
# build-nethack-guest.sh in the guest. It compiles nothing itself. It then
# installs nethack.wasm (fork-instrumented by install_local_binary, because
# the SDK inside Kandelo has no instrumenter yet) and runtime/share/nethack/
# {nhdat,symbols,license}.
#
# Resolver-only: the machine boots the declared kernel and build image.

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"
source "$REPO_ROOT/scripts/package-build-roots.sh"
kandelo_package_load_source_metadata "$SCRIPT_DIR"
# shellcheck source=/dev/null
kandelo_package_prepare_build_roots "$SCRIPT_DIR" wasm32
WORK_DIR="$KANDELO_PACKAGE_WORK_DIR"
# Reproducibility: NetHack's makedefs bakes the build date/time into
# include/date.h — BUILD_DATE, BUILD_TIME, VERSION_ID ("... last build <when>")
# and the copyright banner all derive from it. makedefs uses the wall clock
# unless it is compiled with REPRODUCIBLE_BUILD, in which case it takes the date
# from SOURCE_DATE_EPOCH instead (see util/makedefs.c do_date()). We enable
# REPRODUCIBLE_BUILD on the util build below, and the guest build machine
# passes SOURCE_DATE_EPOCH through.
#
# makedefs sanity-checks SOURCE_DATE_EPOCH and rejects anything before 3.6.0's
# release (7-Dec-2015) or >24h in the future, reverting to the wall clock. The
# local-build engine sets SOURCE_DATE_EPOCH to 315532800 (1980-01-01, the
# ZIP/DOS epoch floor), which predates that window — so honor the engine's value
# when it is acceptable, but bump it to a fixed valid instant when it is too old
# (or unset). Either way both builds embed the same date. 1704067200 =
# 2024-01-01T00:00:00Z; the floor below is 2015-12-07T00:00:00Z.
if [ "${SOURCE_DATE_EPOCH:-0}" -lt 1449446400 ]; then
    export SOURCE_DATE_EPOCH=1704067200
fi
SRC_DIR="$WORK_DIR/nethack-src"
BIN_DIR="$WORK_DIR/bin"
RUNTIME_DIR="$WORK_DIR/runtime"
NETHACK_VERSION="$WASM_POSIX_DEP_VERSION"
NETHACK_SHORT="${NETHACK_VERSION//./}" # Upstream tarballs drop the dots.
SOURCE_URL="$WASM_POSIX_DEP_SOURCE_URL"
SOURCE_SHA256="$WASM_POSIX_DEP_SOURCE_SHA256"
VERIFIED_SOURCE_DIR="${WASM_POSIX_DEP_SOURCE_DIR:-}"
NETHACK_HACKDIR="${NETHACK_HACKDIR:-/usr/share/nethack}"
# The shared playground (saves, scores, bones, lock file), owned by group
# `games` and written through the set-group-ID binary, as Debian and Fedora
# install it. The shell image creates it: see installNethackGames() in
# images/vfs/scripts/shell-lazy-archives.ts.
NETHACK_VAR_PLAYGROUND="${NETHACK_VAR_PLAYGROUND:-/var/games/nethack}"
# The platform name in the version banner and help menu. See the
# include/unixconf.h patch for why it is pinned rather than detected.
NETHACK_PORT_ID="Kandelo"

validate_guest_path() {
    local label="$1"
    local value="$2"
    if [[ "$value" != /* || "$value" == *'"'* || "$value" == *'\\'* || \
          "$value" == *$'\n'* || "$value" == *$'\r'* ]]; then
        echo "ERROR: $label must be an absolute guest path without C-string escapes: $value" >&2
        exit 2
    fi
    if [[ "/${value#/}/" == *'/../'* || "/${value#/}/" == *'/./'* || \
          "/${value#/}/" == *'//'* ]]; then
        echo "ERROR: $label must be normalized: $value" >&2
        exit 2
    fi
}

validate_guest_path NETHACK_HACKDIR "$NETHACK_HACKDIR"
validate_guest_path NETHACK_VAR_PLAYGROUND "$NETHACK_VAR_PLAYGROUND"

for var in WASM_POSIX_DEP_WORK_DIR WASM_POSIX_DEP_OUT_DIR WASM_POSIX_DEP_NCURSES_DIR \
    WASM_POSIX_DEP_KERNEL_DIR WASM_POSIX_DEP_KANDELO_BUILD_IMAGE_DIR; do
    if [ -z "${!var:-}" ]; then
        echo "ERROR: $var is required; build with ./run.sh build nethack" >&2
        exit 2
    fi
done
# The resolver owns the declared work and output roots. Keep the reviewed
# checkout read-only and suppress the developer-only local mirror.
export WASM_POSIX_INSTALL_LOCAL_MIRROR=0
export WASM_POSIX_INSTALL_FORK_INSTRUMENTATION=auto

NCURSES_PREFIX="$WASM_POSIX_DEP_NCURSES_DIR"
if [ ! -f "$NCURSES_PREFIX/lib/libncursesw.a" ]; then
    echo "ERROR: ncurses dependency at '$NCURSES_PREFIX' has no lib/libncursesw.a" >&2
    exit 1
fi
# Where the guest build sees the ncurses dependency (mounted read-only).
GUEST_NCURSES=/deps/ncurses

# --- Stage verified NetHack source ---
rm -rf "$SRC_DIR" "$BIN_DIR" "$RUNTIME_DIR"
echo "==> Staging verified NetHack $NETHACK_VERSION source..."
kandelo_package_stage_verified_source nethack "$SRC_DIR" "$VERIFIED_SOURCE_DIR" \
    "$SOURCE_URL" "$SOURCE_SHA256" "$WORK_DIR"
echo "==> Source staged at $SRC_DIR"

cd "$SRC_DIR"

# --- Setup ---
# setup.sh rewrites top-level Makefile and sub-Makefiles from the chosen
# hints file. hints/linux is the closest match to our musl-based target.
echo "==> Running sys/unix/setup.sh hints/linux..."
(cd sys/unix && sh setup.sh hints/linux)

# --- Patch include/config.h ---
#
# We want CURSES_GRAPHICS enabled. Leaving TTY_GRAPHICS on is harmless —
# NetHack picks the windowing system at runtime via `windowtype`, and leaving
# both compiled in gives the user a choice.
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

    # Drop config.h's fallback compressor (/usr/bin/compress, which the image
    # does not ship). hints/linux still defines COMPRESS=/bin/gzip, so save
    # files are gzipped by forking /bin/gzip with the player's own IDs, as
    # Debian's build does.
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
# Override HACKDIR and add VAR_PLAYGROUND (defaults /usr/share/nethack and
# /var/games/nethack; overridable through the environment).
#
# Pin PORT_ID. NetHack's global.h picks it from the compiler's OS macros
# unless a *conf.h already set it, and this header is included first.
# Without it the banner would say "Unix"; "Kandelo" is the product label.
UNIXCONF_H="include/unixconf.h"
if [ -f "$UNIXCONF_H" ] && ! grep -q "wasm32posix patch" "$UNIXCONF_H"; then
    echo "==> Patching include/unixconf.h..."

    sed -i.bak -E \
        -e 's|^#define HACKDIR.*|/* HACKDIR overridden below */|' \
        -e 's|^#define VAR_PLAYGROUND.*|/* VAR_PLAYGROUND overridden below */|' \
        "$UNIXCONF_H"

    cat >> "$UNIXCONF_H" <<EOF

/* wasm32posix patch */
#define HACKDIR "$NETHACK_HACKDIR"
#define VAR_PLAYGROUND "$NETHACK_VAR_PLAYGROUND"
#define PORT_ID "$NETHACK_PORT_ID"
EOF
    rm -f "$UNIXCONF_H.bak"
fi

# --- Patch include/system.h ---
#
# NetHack's bundled termcap declarations say `tputs` returns void and
# accepts an unprototyped output callback. ncurses declares it as
# `int tputs(const char *, int, int (*)(int))`. Native linkers tolerate the
# return-type mismatch, but wasm-ld has to emit a signature-mismatch trap for
# every caller. The first terminal-control sequence then aborts instantly.
SYSTEM_H="include/system.h"
if [ -f "$SYSTEM_H" ] && ! grep -q "wasm32posix tputs signature patch" "$SYSTEM_H"; then
    echo "==> Patching include/system.h (tputs signature)..."
    awk '
        $0 == "E void FDECL(tputs, (const char *, int, int (*)()));" {
            print "E int FDECL(tputs, (const char *, int, int (*)(int)));"
            next
        }
        { print }
    ' "$SYSTEM_H" > "$SYSTEM_H.new"
    mv "$SYSTEM_H.new" "$SYSTEM_H"
    echo "/* wasm32posix tputs signature patch */" >> "$SYSTEM_H"
fi

# --- Patch win/tty/termcap.c ---
#
# NetHack's TERMINFO branch assumes the terminal's cursor-left capability
# is always exposed as the termcap-style `le` string. ncurses' terminfo
# compatibility layer can return NULL for that lookup even when the browser
# xterm endpoint supports destructive cursor-left/backspace. The non-TERMINFO
# path already falls back to "\b"; apply the same fallback here instead of
# treating a missing `le` alias as a fatal terminal.
TERMCAP_C="win/tty/termcap.c"
if [ -f "$TERMCAP_C" ] && ! grep -q "wasm32posix backspace fallback patch" "$TERMCAP_C"; then
    echo "==> Patching win/tty/termcap.c (backspace fallback)..."
    awk '
        $0 == "    if (!(BC = Tgetstr(\"le\"))) /* both termcap and terminfo use le */" {
            print "    if (!(BC = Tgetstr(\"le\"))) { /* both termcap and terminfo use le */"
            print "#ifdef TERMINFO"
            print "        BC = tbufptr;"
            print "        tbufptr += 2;"
            print "        *BC = 010;"
            print "#else"
            print "        if (!(BC = Tgetstr(\"bc\"))) { /* termcap also uses bc/bs */"
            print "#ifndef MINIMAL_TERM"
            print "            if (!tgetflag(\"bs\"))"
            print "                error(\"Terminal must backspace.\");"
            print "#endif"
            print "            BC = tbufptr;"
            print "            tbufptr += 2;"
            print "            *BC = 010;"
            print "        }"
            print "#endif"
            print "    }"
            skip = 1
            depth = 0
            next
        }
        skip {
            if ($0 ~ /^#if/) depth++
            if ($0 ~ /^#endif/) {
                depth--
                if (depth == 0) skip = 0
            }
            next
        }
        { print }
    ' "$TERMCAP_C" > "$TERMCAP_C.new"
    mv "$TERMCAP_C.new" "$TERMCAP_C"
    echo "/* wasm32posix backspace fallback patch */" >> "$TERMCAP_C"
fi

# --- Patch src/Makefile for ncursesw + include path ---
#
# src/Makefile was generated by setup.sh (populated from sys/unix/hints/linux
# + Makefile.src). It hardcodes:
#   WINTTYLIB=-lncurses -ltinfo
#   WINCURSESLIB=-lncurses
# The ncurses package ships the wide-character flavor (libncursesw,
# libtinfow), matching vim's build, with its headers under
# include/ncursesw.
SRC_MAKEFILE="src/Makefile"
if [ -f "$SRC_MAKEFILE" ] && ! grep -q "wasm32posix patch" "$SRC_MAKEFILE"; then
    echo "==> Patching src/Makefile..."

    sed -i.bak -E \
        -e 's|^WINTTYLIB *=.*|WINTTYLIB=-lncursesw -ltinfow|' \
        -e 's|^WINCURSESLIB *=.*|WINCURSESLIB=-lncursesw -ltinfow|' \
        "$SRC_MAKEFILE"

    # Drop -DSYSCF: the image ships no sysconf file, so the compile-time
    # defaults apply. Keep -DSECURE: the binary is set-group-ID `games`, and
    # SECURE makes NetHack give up that group before using a data directory
    # the player chose with -d.
    sed -i.bak -E \
        -e 's|^CFLAGS\+=-DSYSCF -DSYSCF_FILE=.*|CFLAGS+=-DSECURE|' \
        -e 's|^CFLAGS\+=-DCONFIG_ERROR_SECURE=.*|# -DCONFIG_ERROR_SECURE disabled for wasm32|' \
        "$SRC_MAKEFILE"

    # Append an additional CFLAGS line after the hints-supplied block so
    # the ncursesw headers and libraries resolve where the guest mounts
    # them. The hints set LFLAGS=-rdynamic with `=` (not `+=`)
    # later in the Makefile, which would clobber a `LFLAGS+=...` that
    # appeared earlier — so rewrite `LFLAGS=-rdynamic` to `LFLAGS+=...`
    # that prepends our `-L` to whatever was set previously.
    awk -v ncurses="$GUEST_NCURSES" '
        /^CFLAGS\+=-DCURSES_GRAPHICS/ {
            print;
            print "CFLAGS+=-I" ncurses "/include/ncursesw -I" ncurses "/include";
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

# --- Patch util/Makefile to compile makedefs with REPRODUCIBLE_BUILD ---
#
# makedefs only honors SOURCE_DATE_EPOCH (exported above) when built with
# REPRODUCIBLE_BUILD. Enabling it via include/config.h did not reach makedefs's
# compile in practice, so append it to the util Makefile's CFLAGS directly.
# `+=` at the end is the last assignment make sees, so it survives any earlier
# `CFLAGS=` in the hints-generated Makefile.
UTIL_MAKEFILE="util/Makefile"
if [ -f "$UTIL_MAKEFILE" ] && ! grep -q "wasm32posix patch" "$UTIL_MAKEFILE"; then
    echo "==> Patching util/Makefile (REPRODUCIBLE_BUILD)..."
    printf '\nCFLAGS+=-DREPRODUCIBLE_BUILD\n# wasm32posix patch\n' >> "$UTIL_MAKEFILE"
fi

# --- Build inside Kandelo ---
cp "$SCRIPT_DIR/build-nethack-guest.sh" "$SRC_DIR/build-nethack-guest.sh"
source "$REPO_ROOT/scripts/guest-build.sh"
echo "==> Building NetHack inside a Kandelo machine..."
kandelo_guest_build --workspace "$SRC_DIR" \
    --input "$GUEST_NCURSES=$NCURSES_PREFIX" \
    -- /bin/sh /build/build-nethack-guest.sh

# --- Stage outputs ---
echo "==> Staging outputs..."

# The guest's files reach the host as mode 0600; set modes while installing.
mkdir -p "$BIN_DIR"
install -m 0755 "$SRC_DIR/src/nethack" "$BIN_DIR/nethack.wasm"

source "$REPO_ROOT/scripts/install-local-binary.sh"
install_local_binary nethack "$BIN_DIR/nethack.wasm"

mkdir -p "$RUNTIME_DIR/share/nethack"
for file in nhdat symbols license; do
    install -m 0644 "$SRC_DIR/dat/$file" "$RUNTIME_DIR/share/nethack/$file"
done

# Stage the runtime tree into the resolver output so it lands in the cache
# canonical path (and from there, the .tar.zst release archive): the
# archive then holds nethack.wasm and runtime/share/nethack/*. Mirrors
# packages/registry/vim/build-vim.sh.
rm -rf "$WASM_POSIX_DEP_OUT_DIR/runtime"
cp -R "$RUNTIME_DIR" "$WASM_POSIX_DEP_OUT_DIR/runtime"

SIZE=$(wc -c < "$BIN_DIR/nethack.wasm" | tr -d ' ')
echo "==> Final size: $(echo "$SIZE" | numfmt --to=iec 2>/dev/null || echo "${SIZE} bytes")"

echo ""
echo "==> NetHack $NETHACK_VERSION built successfully!"
echo "Binary:  $BIN_DIR/nethack.wasm"
echo "Runtime: $RUNTIME_DIR/share/nethack/"
