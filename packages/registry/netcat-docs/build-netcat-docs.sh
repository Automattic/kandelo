#!/usr/bin/env bash
# Ship the `netcat` package's upstream manual pages as netcat-docs.zip, a
# lazy archive mounted at /usr/. Only pages for commands the image
# installs (nc, and netcat as an alias of it) are shipped.
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$HERE/../../.." && pwd)"
# shellcheck source=/dev/null
source "$REPO_ROOT/scripts/install-package-man-pages.sh"
kandelo_man_pages_stage_source "$HERE"
SRC="$KANDELO_MAN_PAGES_SOURCE"

install_package_man_pages netcat-docs "$SRC" \
    doc/netcat.1 \
    nc.1=netcat.1
