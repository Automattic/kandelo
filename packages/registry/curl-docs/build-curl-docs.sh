#!/usr/bin/env bash
# Ship curl's manual page as curl-docs.zip, a lazy archive mounted at /usr/.
# The release tarball carries no curl.1: curl's build generates it from the
# Markdown option descriptions in docs/cmdline-opts with its own Perl
# generator, scripts/managen. This runs that rule from
# docs/cmdline-opts/Makefile.am unchanged. managen dates the page from
# SOURCE_DATE_EPOCH, so that is set to the release date curl records in
# include/curl/curlver.h (LIBCURL_TIMESTAMP) rather than the build's own
# epoch. libcurl's section 3 pages and curl-config are not shipped; the
# image installs neither.
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$HERE/../../.." && pwd)"
# shellcheck source=/dev/null
source "$REPO_ROOT/scripts/install-package-man-pages.sh"
kandelo_man_pages_stage_source "$HERE"
SRC="$KANDELO_MAN_PAGES_SOURCE"

(
    cd "$SRC/docs/cmdline-opts"
    # DPAGES, the option pages in order, is defined by upstream's Makefile.inc.
    dpages="$(printf 'include Makefile.inc\nprint:\n\t@echo $(DPAGES)\n' | make -s -f - print)"
    [ -n "$dpages" ] || { echo "build-curl-docs: Makefile.inc lists no DPAGES" >&2; exit 1; }
    stamp="$(sed -n 's/^#define LIBCURL_TIMESTAMP "\([0-9-]*\)"$/\1/p' ../../include/curl/curlver.h)"
    [ -n "$stamp" ] || { echo "build-curl-docs: no LIBCURL_TIMESTAMP in curlver.h" >&2; exit 1; }
    SOURCE_DATE_EPOCH="$(perl -MTime::Piece -e 'print Time::Piece->strptime($ARGV[0], "%Y-%m-%d")->epoch' "$stamp")"
    export SOURCE_DATE_EPOCH
    # shellcheck disable=SC2086
    perl ../../scripts/managen -d . -I ../../include mainpage $dpages > curl.1
)

install_package_man_pages curl-docs "$SRC" \
    docs/cmdline-opts/curl.1
