#!/usr/bin/env bash
# Ship the `patch` package's upstream manual page as patch-docs.zip, a lazy
# archive mounted at /usr/. Upstream keeps the troff source in patch.man and
# installs it as patch.1.
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$HERE/../../.." && pwd)"
# shellcheck source=/dev/null
source "$REPO_ROOT/scripts/install-package-man-pages.sh"
kandelo_man_pages_stage_source "$HERE"
SRC="$KANDELO_MAN_PAGES_SOURCE"

install_package_man_pages patch-docs "$SRC" \
    patch.man:patch.1
