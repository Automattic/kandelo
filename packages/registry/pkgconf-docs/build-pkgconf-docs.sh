#!/usr/bin/env bash
# Ship the `pkgconf` package's upstream manual pages as pkgconf-docs.zip, a lazy
# archive mounted at /usr/. Only pages for what the image installs are
# shipped: pkgconf, its pkg-config name, and the formats it reads: .pc files
# (pc.5), personality files (pkgconf-personality.5) and pkg.m4, which
# pkgconf-data installs (pkg.m4.7). bomtool, pccritic and spdxtool are
# not built.
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$HERE/../../.." && pwd)"
# shellcheck source=/dev/null
source "$REPO_ROOT/scripts/install-package-man-pages.sh"
kandelo_man_pages_stage_source "$HERE"
SRC="$KANDELO_MAN_PAGES_SOURCE"

install_package_man_pages pkgconf-docs "$SRC" \
    man/pkgconf.1 \
    pkg-config.1=pkgconf.1 \
    man/pc.5 \
    man/pkgconf-personality.5 \
    man/pkg.m4.7
