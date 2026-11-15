#!/usr/bin/env bash
# Ship the `meson` package's upstream manual page as meson-docs.zip, a lazy
# archive mounted at /usr/. The release tarball carries man/meson.1, which
# upstream's setup.py installs as share/man/man1/meson.1.
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$HERE/../../.." && pwd)"
# shellcheck source=/dev/null
source "$REPO_ROOT/scripts/install-package-man-pages.sh"
kandelo_man_pages_stage_source "$HERE"
SRC="$KANDELO_MAN_PAGES_SOURCE"

install_package_man_pages meson-docs "$SRC" \
    man/meson.1
