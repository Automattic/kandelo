#!/usr/bin/env bash
# Ship the `xz` package's upstream manual pages as xz-docs.zip, a
# lazy archive mounted at /usr/. Only pages for commands the image
# installs (xz, unxz, xzcat, lzma, unlzma, lzcat) are shipped.
# xz's install step links these five names to xz.1. xzdec, lzmainfo and
# the xz* scripts are not installed.
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$HERE/../../.." && pwd)"
# shellcheck source=/dev/null
source "$REPO_ROOT/scripts/install-package-man-pages.sh"
kandelo_man_pages_stage_source "$HERE"
SRC="$KANDELO_MAN_PAGES_SOURCE"

install_package_man_pages xz-docs "$SRC" \
    src/xz/xz.1 \
    unxz.1=xz.1 \
    xzcat.1=xz.1 \
    lzma.1=xz.1 \
    unlzma.1=xz.1 \
    lzcat.1=xz.1
