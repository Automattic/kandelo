#!/usr/bin/env bash
# Ship the `ncurses` package's manual pages for its programs as
# ncurses-docs.zip, a lazy archive mounted at /usr/.
#
# Upstream's pages are templates that its install step rewrites:
# configure generates man/edit_man.sh, which fills in program names,
# version and paths and installs each page and alias, and MKterminfo.sh
# assembles terminfo(5) from the capability table. The build-ncurses.sh
# configure only builds the library and programs (--without-manpages,
# with the resolver's output directory as prefix), so this runs ncurses'
# configure for the build machine with what the pages state: the image's
# /usr prefix and build-ncurses.sh's terminfo directories, which this
# script checks are still the ones it passes. The page format is fixed
# (plain troff, no renames) rather than detected from the build machine.
#
# Pages shipped: the programs the image installs (clear, reset, tset,
# tput, tabs, tic, infocmp, toe, captoinfo, infotocap), the terminfo
# source and compiled formats they read and write (terminfo(5), term(5),
# user_caps(5)) and term(7), the TERM naming conventions. Library (3x)
# pages, ncursesw6-config(1) and scr_dump(5) are not shipped.
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$HERE/../../.." && pwd)"
# shellcheck source=/dev/null
source "$REPO_ROOT/scripts/install-package-man-pages.sh"
kandelo_man_pages_stage_source "$HERE"
SRC="$KANDELO_MAN_PAGES_SOURCE"
WORK="$KANDELO_PACKAGE_WORK_DIR"

TERMINFO_DIR=/usr/share/terminfo
NCURSES_BUILD="$REPO_ROOT/packages/registry/ncurses/build-ncurses.sh"
for flag in "--with-default-terminfo-dir=$TERMINFO_DIR" "--with-terminfo-dirs=$TERMINFO_DIR"; do
    grep -qE "^[[:space:]]+$flag \\\\\$" "$NCURSES_BUILD" || {
        echo "build-ncurses-docs: build-ncurses.sh no longer configures $flag" >&2
        exit 1
    }
done

BUILD="$WORK/ncurses-man-build"
DEST="$WORK/ncurses-man-root"
rm -rf "$BUILD" "$DEST"
mkdir -p "$BUILD" "$DEST"
# MKterminfo.sh names its input files in a comment of terminfo(5), as the
# build sees them; reaching the source by a relative path keeps the build
# directory's location out of the page.
[ "$(dirname "$SRC")" = "$WORK" ] || {
    echo "build-ncurses-docs: expected the staged source directly under $WORK" >&2
    exit 1
}
(
    cd "$BUILD"
    CC=cc "../$(basename "$SRC")/configure" \
        --prefix=/usr \
        --with-default-terminfo-dir="$TERMINFO_DIR" \
        --with-terminfo-dirs="$TERMINFO_DIR" \
        --enable-widec \
        --with-manpages \
        --with-manpage-format=normal \
        --with-manpage-renames=no \
        --with-manpage-aliases \
        --with-manpage-symlinks \
        --without-cxx --without-cxx-binding --without-ada --without-tests \
        > "$WORK/configure.log" 2>&1 || { tail -40 config.log >&2; exit 1; }
    make -C man install DESTDIR="$DEST" > "$WORK/make-man.log" 2>&1 || {
        tail -40 "$WORK/make-man.log" >&2
        exit 1
    }
)

install_package_man_pages ncurses-docs "$DEST/usr/share/man" \
    man1/clear.1 \
    man1/tset.1 \
    reset.1=tset.1 \
    man1/tput.1 \
    man1/tabs.1 \
    man1/tic.1m \
    man1/infocmp.1m \
    man1/toe.1m \
    man1/captoinfo.1m \
    man1/infotocap.1m \
    man5/terminfo.5 \
    man5/term.5 \
    man5/user_caps.5 \
    man7/term.7
