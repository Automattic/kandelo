#!/usr/bin/env bash
# Ship the `mandoc` package's upstream manual pages as mandoc-docs.zip, a
# lazy archive mounted at /usr/. Only pages for commands the image
# installs (man, mandoc) are shipped.
# The section 7 pages are the formatting languages mandoc reads. apropos,
# makewhatis, catman, demandoc and soelim are not installed.
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$HERE/../../.." && pwd)"
# shellcheck source=/dev/null
source "$REPO_ROOT/scripts/install-package-man-pages.sh"
kandelo_man_pages_stage_source "$HERE"
SRC="$KANDELO_MAN_PAGES_SOURCE"

install_package_man_pages mandoc-docs "$SRC" \
    man.1 \
    mandoc.1 \
    man.conf.5 \
    man.7 \
    mdoc.7 \
    roff.7 \
    tbl.7 \
    eqn.7 \
    mandoc_char.7
