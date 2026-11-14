#!/usr/bin/env bash
# Ship the `help2man` package's upstream manual pages as help2man-docs.zip, a lazy
# archive mounted at /usr/. Only pages for what the image installs are
# shipped: help2man. The translated pages (help2man.<lang>.1) are not
# shipped, as the package installs no translations.
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$HERE/../../.." && pwd)"
# shellcheck source=/dev/null
source "$REPO_ROOT/scripts/install-package-man-pages.sh"
kandelo_man_pages_stage_source "$HERE"
SRC="$KANDELO_MAN_PAGES_SOURCE"

install_package_man_pages help2man-docs "$SRC" \
    help2man.1
