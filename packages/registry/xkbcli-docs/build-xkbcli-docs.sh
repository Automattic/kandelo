#!/usr/bin/env bash
# Ship the `xkbcli` package's upstream manual pages as xkbcli-docs.zip,
# a lazy archive mounted at /usr/. Only pages for the commands the image
# installs (xkbcli, xkbcli compile-keymap) are shipped.
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$HERE/../../.." && pwd)"
# shellcheck source=/dev/null
source "$REPO_ROOT/scripts/install-package-man-pages.sh"
kandelo_man_pages_stage_source "$HERE"
SRC="$KANDELO_MAN_PAGES_SOURCE"

install_package_man_pages xkbcli-docs "$SRC" \
    tools/xkbcli.1 \
    tools/xkbcli-compile-keymap.1
