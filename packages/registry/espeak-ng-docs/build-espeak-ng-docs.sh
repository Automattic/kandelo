#!/usr/bin/env bash
# Ship the `espeak-ng` package's manual page as espeak-ng-docs.zip, a lazy
# archive mounted at /usr/.
#
# Upstream writes it in ronn's Markdown dialect and its Makefile runs
# `ronn --roff` over src/espeak-ng.1.ronn; this does the same with the dev
# shell's ronn. ronn would otherwise date the page from the source file's
# modification time, so it is given the release's date. speak-ng(1) is
# not shipped: the image installs espeak-ng only.
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$HERE/../../.." && pwd)"
# shellcheck source=/dev/null
source "$REPO_ROOT/scripts/install-package-man-pages.sh"
kandelo_man_pages_stage_source "$HERE"
SRC="$KANDELO_MAN_PAGES_SOURCE"
DATE="$(kandelo_man_pages_release_date "$WASM_POSIX_DEP_VERSION" 1.52.0=2024-12-12)"

OUT="$SRC/kandelo-man"
rm -rf "$OUT"
mkdir -p "$OUT"
cp "$SRC/src/espeak-ng.1.ronn" "$OUT/espeak-ng.1.ronn"
ronn --roff --date="$DATE" -o "$OUT" "$OUT/espeak-ng.1.ronn" > "$KANDELO_PACKAGE_WORK_DIR/ronn.log" 2>&1 || {
    cat "$KANDELO_PACKAGE_WORK_DIR/ronn.log" >&2
    exit 1
}

install_package_man_pages espeak-ng-docs "$SRC" kandelo-man/espeak-ng.1
