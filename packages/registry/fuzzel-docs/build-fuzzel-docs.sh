#!/usr/bin/env bash
# Ship the `fuzzel` package's manual pages as fuzzel-docs.zip, a lazy
# archive mounted at /usr/. Upstream writes them in scdoc; meson.build runs
# scdoc over them.
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$HERE/../../.." && pwd)"
# shellcheck source=/dev/null
source "$REPO_ROOT/scripts/install-package-man-pages.sh"
kandelo_man_pages_stage_source "$HERE"
SRC="$KANDELO_MAN_PAGES_SOURCE"
DATE="$(kandelo_man_pages_release_date "$WASM_POSIX_DEP_VERSION" 1.15.0=2026-09-02)"

pages=(
    doc/fuzzel.1.scd
    doc/fuzzel.ini.5.scd
)
specs=()
for page in "${pages[@]}"; do
    name="$(basename "$page" .scd)"
    kandelo_man_pages_scdoc "$DATE" "$SRC/$page" "$SRC/kandelo-man/$name"
    specs+=("kandelo-man/$name")
done
install_package_man_pages fuzzel-docs "$SRC" "${specs[@]}"
