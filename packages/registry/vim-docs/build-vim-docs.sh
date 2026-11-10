#!/usr/bin/env bash
# Ship the `vim` package's upstream manual pages as vim-docs.zip, a
# lazy archive mounted at /usr/. Only pages for commands the image
# installs (vim) are shipped.
# vim keeps troff in .1 files; the .man files are preformatted. evim,
# vimdiff, vimtutor and xxd are not installed.
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$HERE/../../.." && pwd)"
# shellcheck source=/dev/null
source "$REPO_ROOT/scripts/install-package-man-pages.sh"
kandelo_man_pages_stage_source "$HERE"
SRC="$KANDELO_MAN_PAGES_SOURCE"

install_package_man_pages vim-docs "$SRC" \
    runtime/doc/vim.1
