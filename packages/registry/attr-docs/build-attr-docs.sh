#!/usr/bin/env bash
# Ship the `attr` package's upstream manual pages as attr-docs.zip, a
# lazy archive mounted at /usr/. Only pages for commands the image
# installs (getfattr, setfattr) are shipped.
# attr(1) documents the IRIX-compatible `attr` command, which the
# image does not install, so it is not shipped.
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$HERE/../../.." && pwd)"
# shellcheck source=/dev/null
source "$REPO_ROOT/scripts/install-package-man-pages.sh"
kandelo_man_pages_stage_source "$HERE"
SRC="$KANDELO_MAN_PAGES_SOURCE"

install_package_man_pages attr-docs "$SRC" \
    man/man1/getfattr.1 \
    man/man1/setfattr.1
