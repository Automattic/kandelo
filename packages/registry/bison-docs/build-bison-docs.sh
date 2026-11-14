#!/usr/bin/env bash
# Ship the `bison` package's upstream manual pages as bison-docs.zip, a lazy
# archive mounted at /usr/. Only pages for what the image installs are
# shipped: bison. The package is built with --disable-yacc, so yacc.1 (which
# would describe Bison's yacc wrapper) is not shipped; /usr/bin/yacc is
# Berkeley yacc, documented by byacc-docs.
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$HERE/../../.." && pwd)"
# shellcheck source=/dev/null
source "$REPO_ROOT/scripts/install-package-man-pages.sh"
kandelo_man_pages_stage_source "$HERE"
SRC="$KANDELO_MAN_PAGES_SOURCE"

install_package_man_pages bison-docs "$SRC" \
    doc/bison.1
