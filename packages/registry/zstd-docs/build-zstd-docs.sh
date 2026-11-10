#!/usr/bin/env bash
# Ship the `zstd` package's upstream manual pages as zstd-docs.zip, a
# lazy archive mounted at /usr/. Only pages for commands the image
# installs (zstd, unzstd, zstdcat) are shipped.
# zstd's install step links unzstd.1 and zstdcat.1 to zstd.1. zstdgrep
# and zstdless are not installed.
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$HERE/../../.." && pwd)"
# shellcheck source=/dev/null
source "$REPO_ROOT/scripts/install-package-man-pages.sh"
kandelo_man_pages_stage_source "$HERE"
SRC="$KANDELO_MAN_PAGES_SOURCE"

install_package_man_pages zstd-docs "$SRC" \
    programs/zstd.1 \
    unzstd.1=zstd.1 \
    zstdcat.1=zstd.1
