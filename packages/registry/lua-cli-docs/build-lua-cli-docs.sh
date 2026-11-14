#!/usr/bin/env bash
# Ship the `lua-cli` package's upstream manual page as lua-cli-docs.zip,
# a lazy archive mounted at /usr/. luac is not installed, so luac.1 is
# not shipped.
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$HERE/../../.." && pwd)"
# shellcheck source=/dev/null
source "$REPO_ROOT/scripts/install-package-man-pages.sh"
kandelo_man_pages_stage_source "$HERE"
SRC="$KANDELO_MAN_PAGES_SOURCE"

install_package_man_pages lua-cli-docs "$SRC" \
    doc/lua.1
