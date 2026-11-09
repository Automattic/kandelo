#!/usr/bin/env bash
# Ship the `nethack` package's upstream manual pages as nethack-docs.zip, a
# lazy archive mounted at /usr/. Only pages for commands the image
# installs (nethack) are shipped.
# recover(6) and the build-tool pages are not shipped; those programs are
# not installed.
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$HERE/../../.." && pwd)"
# shellcheck source=/dev/null
source "$REPO_ROOT/scripts/install-package-man-pages.sh"
kandelo_man_pages_stage_source "$HERE"
SRC="$KANDELO_MAN_PAGES_SOURCE"

install_package_man_pages nethack-docs "$SRC" \
    doc/nethack.6
