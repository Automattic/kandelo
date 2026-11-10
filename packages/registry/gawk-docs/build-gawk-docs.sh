#!/usr/bin/env bash
# Ship the `gawk` package's upstream manual pages as gawk-docs.zip, a
# lazy archive mounted at /usr/. Only pages for commands the image
# installs (gawk, and awk as an alias of it) are shipped.
# gawkbug(1) and pm-gawk(1) document things the image does not install.
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$HERE/../../.." && pwd)"
# shellcheck source=/dev/null
source "$REPO_ROOT/scripts/install-package-man-pages.sh"
kandelo_man_pages_stage_source "$HERE"
SRC="$KANDELO_MAN_PAGES_SOURCE"

install_package_man_pages gawk-docs "$SRC" \
    doc/gawk.1 \
    awk.1=gawk.1
