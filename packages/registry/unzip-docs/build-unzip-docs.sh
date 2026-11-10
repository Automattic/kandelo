#!/usr/bin/env bash
# Ship the `unzip` package's upstream manual pages as unzip-docs.zip, a
# lazy archive mounted at /usr/. Only pages for commands the image
# installs (unzip, zipinfo, funzip) are shipped.
# unzipsfx and zipgrep are not installed.
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$HERE/../../.." && pwd)"
# shellcheck source=/dev/null
source "$REPO_ROOT/scripts/install-package-man-pages.sh"
kandelo_man_pages_stage_source "$HERE"
SRC="$KANDELO_MAN_PAGES_SOURCE"

install_package_man_pages unzip-docs "$SRC" \
    man/unzip.1 \
    man/zipinfo.1 \
    man/funzip.1
