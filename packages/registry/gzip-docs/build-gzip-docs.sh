#!/usr/bin/env bash
# Ship the `gzip` package's upstream manual pages as gzip-docs.zip, a
# lazy archive mounted at /usr/. Only pages for commands the image
# installs (gzip, gunzip, zcat) are shipped.
# gunzip.1 and zcat.1 are upstream's own `.so man1/gzip.1` pages. The z*
# helper scripts are not installed.
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$HERE/../../.." && pwd)"
# shellcheck source=/dev/null
source "$REPO_ROOT/scripts/install-package-man-pages.sh"
kandelo_man_pages_stage_source "$HERE"
SRC="$KANDELO_MAN_PAGES_SOURCE"

install_package_man_pages gzip-docs "$SRC" \
    gzip.1 \
    gunzip.1 \
    zcat.1
