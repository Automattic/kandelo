#!/usr/bin/env bash
# Ship the `findutils` package's upstream manual pages as findutils-docs.zip, a
# lazy archive mounted at /usr/. Only pages for commands the image
# installs (find, xargs) are shipped.
# locate(1), updatedb(1) and locatedb(5) document tools the image does not install.
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$HERE/../../.." && pwd)"
# shellcheck source=/dev/null
source "$REPO_ROOT/scripts/install-package-man-pages.sh"
kandelo_man_pages_stage_source "$HERE"
SRC="$KANDELO_MAN_PAGES_SOURCE"

install_package_man_pages findutils-docs "$SRC" \
    find/find.1 \
    xargs/xargs.1
