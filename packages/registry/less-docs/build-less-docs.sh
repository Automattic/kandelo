#!/usr/bin/env bash
# Ship the `less` package's upstream manual pages as less-docs.zip, a
# lazy archive mounted at /usr/. Only pages for commands the image
# installs (less) are shipped.
# less keeps troff source in less.nro; less.man is preformatted output.
# lesskey and lessecho are not installed.
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$HERE/../../.." && pwd)"
# shellcheck source=/dev/null
source "$REPO_ROOT/scripts/install-package-man-pages.sh"
kandelo_man_pages_stage_source "$HERE"
SRC="$KANDELO_MAN_PAGES_SOURCE"

install_package_man_pages less-docs "$SRC" \
    less.nro:less.1
