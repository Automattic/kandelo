#!/usr/bin/env bash
# Ship the `grep` package's upstream manual pages as grep-docs.zip, a
# lazy archive mounted at /usr/. Only pages for commands the image
# installs (grep, egrep, fgrep) are shipped.
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$HERE/../../.." && pwd)"
# shellcheck source=/dev/null
source "$REPO_ROOT/scripts/install-package-man-pages.sh"
kandelo_man_pages_stage_source "$HERE"
SRC="$KANDELO_MAN_PAGES_SOURCE"

# Upstream's doc/Makefile.am generates grep.1 from grep.in.1 with this
# single substitution. grep.1 does not describe egrep or fgrep, so
# no alias pages are added for them.
kandelo_man_pages_substitute "$SRC/doc/grep.in.1" "$SRC/doc/grep.1" \
    "@VERSION@=$WASM_POSIX_DEP_VERSION"

install_package_man_pages grep-docs "$SRC" \
    doc/grep.1
