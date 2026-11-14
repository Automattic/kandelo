#!/usr/bin/env bash
# Ship the `texinfo` package's upstream manual pages as texinfo-docs.zip, a lazy
# archive mounted at /usr/. Only pages for what the image installs are
# shipped: the Texinfo commands the image installs (texi2any, makeinfo,
# texindex, texi2dvi, texi2pdf, pdftexi2dvi, pod2texi, install-info) and
# the Texinfo language (texinfo.5). The info reader is not built, so
# info.1 and info.5 are not shipped.
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$HERE/../../.." && pwd)"
# shellcheck source=/dev/null
source "$REPO_ROOT/scripts/install-package-man-pages.sh"
kandelo_man_pages_stage_source "$HERE"
SRC="$KANDELO_MAN_PAGES_SOURCE"

install_package_man_pages texinfo-docs "$SRC" \
    man/texi2any.1 \
    man/makeinfo.1 \
    man/texindex.1 \
    man/texi2dvi.1 \
    man/texi2pdf.1 \
    man/pdftexi2dvi.1 \
    man/pod2texi.1 \
    man/install-info.1 \
    man/texinfo.5
