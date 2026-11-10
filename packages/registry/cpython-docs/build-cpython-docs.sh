#!/usr/bin/env bash
# Ship the `cpython` package's upstream manual pages as cpython-docs.zip, a
# lazy archive mounted at /usr/. Only pages for commands the image
# installs (python3, and python as an alias of it) are shipped.
# CPython's own install step installs Misc/python.man as python3.1.
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$HERE/../../.." && pwd)"
# shellcheck source=/dev/null
source "$REPO_ROOT/scripts/install-package-man-pages.sh"
kandelo_man_pages_stage_source "$HERE"
SRC="$KANDELO_MAN_PAGES_SOURCE"

install_package_man_pages cpython-docs "$SRC" \
    Misc/python.man:python3.1 \
    python.1=python3.1
