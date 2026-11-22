#!/usr/bin/env bash
# Ship the `autoconf` package's upstream manual pages as autoconf-docs.zip, a lazy
# archive mounted at /usr/. Only pages for what the image installs are
# shipped: the Autoconf commands the image installs (autoconf, autoheader,
# autom4te, autoreconf, autoscan, autoupdate, ifnames).
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$HERE/../../.." && pwd)"
# shellcheck source=/dev/null
source "$REPO_ROOT/scripts/install-package-man-pages.sh"
kandelo_man_pages_stage_source "$HERE"
SRC="$KANDELO_MAN_PAGES_SOURCE"

install_package_man_pages autoconf-docs "$SRC" \
    man/autoconf.1 \
    man/autoheader.1 \
    man/autom4te.1 \
    man/autoreconf.1 \
    man/autoscan.1 \
    man/autoupdate.1 \
    man/ifnames.1
