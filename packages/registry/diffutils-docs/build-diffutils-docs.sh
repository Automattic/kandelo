#!/usr/bin/env bash
# Ship the `diffutils` package's upstream manual pages as diffutils-docs.zip, a
# lazy archive mounted at /usr/. Only pages for commands the image
# installs (diff, cmp, diff3, sdiff) are shipped.
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$HERE/../../.." && pwd)"
# shellcheck source=/dev/null
source "$REPO_ROOT/scripts/install-package-man-pages.sh"
kandelo_man_pages_stage_source "$HERE"
SRC="$KANDELO_MAN_PAGES_SOURCE"

install_package_man_pages diffutils-docs "$SRC" \
    man/diff.1 \
    man/cmp.1 \
    man/diff3.1 \
    man/sdiff.1
