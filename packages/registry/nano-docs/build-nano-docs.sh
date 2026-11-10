#!/usr/bin/env bash
# Ship the `nano` package's upstream manual pages as nano-docs.zip, a
# lazy archive mounted at /usr/. Only pages for commands the image
# installs (nano) are shipped.
# rnano(1) documents a restricted build the image does not install.
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$HERE/../../.." && pwd)"
# shellcheck source=/dev/null
source "$REPO_ROOT/scripts/install-package-man-pages.sh"
kandelo_man_pages_stage_source "$HERE"
SRC="$KANDELO_MAN_PAGES_SOURCE"

install_package_man_pages nano-docs "$SRC" \
    doc/nano.1 \
    doc/nanorc.5
