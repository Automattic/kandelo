#!/usr/bin/env bash
# Ship the `elinks` package's upstream manual pages as elinks-docs.zip, a
# lazy archive mounted at /usr/. Only pages for commands the image
# installs (elinks) are shipped.
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$HERE/../../.." && pwd)"
# shellcheck source=/dev/null
source "$REPO_ROOT/scripts/install-package-man-pages.sh"
kandelo_man_pages_stage_source "$HERE"
SRC="$KANDELO_MAN_PAGES_SOURCE"

# configure fills @sysconfdir@ into elinks.1.in. The elinks package
# configures with --sysconfdir=/etc/elinks (build-elinks.sh).
kandelo_man_pages_substitute "$SRC/doc/man/man1/elinks.1.in" "$SRC/elinks.1" \
    '@sysconfdir@=/etc/elinks'

install_package_man_pages elinks-docs "$SRC" \
    elinks.1 \
    doc/man/man5/elinks.conf.5 \
    doc/man/man5/elinkskeys.5
