#!/usr/bin/env bash
# Ship the `bc` package's upstream manual pages as bc-docs.zip, a
# lazy archive mounted at /usr/. Only pages for commands the image
# installs (bc) are shipped.
# dc(1) is not shipped: the package installs no dc.
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$HERE/../../.." && pwd)"
# shellcheck source=/dev/null
source "$REPO_ROOT/scripts/install-package-man-pages.sh"
kandelo_man_pages_stage_source "$HERE"
SRC="$KANDELO_MAN_PAGES_SOURCE"

install_package_man_pages bc-docs "$SRC" \
    doc/bc.1
