#!/usr/bin/env bash
# Ship the `sfwbar` package's upstream manual pages as sfwbar-docs.zip, a
# lazy archive mounted at /usr/. Only pages for commands the image
# installs (sfwbar and its appmenu module) are shipped.
# Upstream ships these pages prebuilt from reStructuredText and its
# meson.build installs sfwbar.1 plus one page per module it builds; the
# sfwbar package builds only appmenu.so. sfwbar-widgets.1 is never
# installed upstream.
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$HERE/../../.." && pwd)"
# shellcheck source=/dev/null
source "$REPO_ROOT/scripts/install-package-man-pages.sh"
kandelo_man_pages_stage_source "$HERE"
SRC="$KANDELO_MAN_PAGES_SOURCE"

install_package_man_pages sfwbar-docs "$SRC" \
    doc/sfwbar.1 \
    doc/sfwbar-appmenu.1
