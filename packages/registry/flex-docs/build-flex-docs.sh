#!/usr/bin/env bash
# Ship the `flex` package's upstream manual pages as flex-docs.zip, a
# lazy archive mounted at /usr/. Only pages for commands the image
# installs (flex, and lex as an alias of it) are shipped.
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$HERE/../../.." && pwd)"
# shellcheck source=/dev/null
source "$REPO_ROOT/scripts/install-package-man-pages.sh"
kandelo_man_pages_stage_source "$HERE"
SRC="$KANDELO_MAN_PAGES_SOURCE"

install_package_man_pages flex-docs "$SRC" \
    doc/flex.1 \
    lex.1=flex.1
