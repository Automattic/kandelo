#!/usr/bin/env bash
# Ship the `bzip2` package's upstream manual pages as bzip2-docs.zip, a
# lazy archive mounted at /usr/. Only pages for commands the image
# installs (bzip2, bunzip2, bzcat) are shipped.
# bzip2.1 documents bunzip2 and bzcat too; bzdiff/bzgrep/bzmore are not installed.
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$HERE/../../.." && pwd)"
# shellcheck source=/dev/null
source "$REPO_ROOT/scripts/install-package-man-pages.sh"
kandelo_man_pages_stage_source "$HERE"
SRC="$KANDELO_MAN_PAGES_SOURCE"

install_package_man_pages bzip2-docs "$SRC" \
    bzip2.1 \
    bunzip2.1=bzip2.1 \
    bzcat.1=bzip2.1
