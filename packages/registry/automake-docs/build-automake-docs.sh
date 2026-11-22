#!/usr/bin/env bash
# Ship manual pages for the automake package's commands (automake,
# aclocal and their versioned names automake-1.20 and aclocal-1.20) as
# automake-docs.zip, a lazy archive mounted at /usr/.
#
# Automake's release tarball carries no pages: its normal build makes
# them, running the help2man copy it distributes (doc/help2man) over the
# just-built scripts (Makefile.in, update_mans). This recipe runs that
# rule over the pinned source, configured with the automake package's
# --prefix=/usr, and ships what it writes: aclocal-1.20.1 and
# automake-1.20.1, and the aclocal.1 and automake.1 ".so" pages that
# point at them. The build's perl runs the scripts, which print no path
# of the machine they run on.
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$HERE/../../.." && pwd)"
# shellcheck source=/dev/null
source "$REPO_ROOT/scripts/install-package-man-pages.sh"
kandelo_man_pages_stage_source "$HERE"
SRC="$KANDELO_MAN_PAGES_SOURCE"
VERSION="${WASM_POSIX_DEP_VERSION:?}"
# help2man dates each page from SOURCE_DATE_EPOCH; the dev shell's clock
# reads 1980.
DATE="$(kandelo_man_pages_release_date "$VERSION" 1.20=2026-11-07)"
export SOURCE_DATE_EPOCH
SOURCE_DATE_EPOCH="$(kandelo_man_pages_date_epoch "$DATE")"

(cd "$SRC" && ./configure --prefix=/usr) > "$KANDELO_PACKAGE_WORK_DIR/configure.log"
make -C "$SRC" \
    "doc/aclocal-$VERSION.1" "doc/automake-$VERSION.1" \
    doc/aclocal.1 doc/automake.1

install_package_man_pages automake-docs "$SRC" \
    "doc/aclocal-$VERSION.1" \
    "doc/automake-$VERSION.1" \
    doc/aclocal.1 \
    doc/automake.1
