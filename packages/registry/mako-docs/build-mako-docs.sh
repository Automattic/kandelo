#!/usr/bin/env bash
# Ship the `mako` package's manual pages as mako-docs.zip, a lazy
# archive mounted at /usr/. Upstream writes them in scdoc; meson.build runs
# scdoc over them.
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$HERE/../../.." && pwd)"
# shellcheck source=/dev/null
source "$REPO_ROOT/scripts/install-package-man-pages.sh"
kandelo_man_pages_stage_source "$HERE"
SRC="$KANDELO_MAN_PAGES_SOURCE"
DATE="$(kandelo_man_pages_release_date "$WASM_POSIX_DEP_VERSION" 1.10.0=2025-03-16)"

pages=(
    doc/mako.1.scd
    doc/mako.5.scd
    doc/makoctl.1.scd
)
specs=()
for page in "${pages[@]}"; do
    name="$(basename "$page" .scd)"
    kandelo_man_pages_scdoc "$DATE" "$SRC/$page" "$SRC/kandelo-man/$name"
    specs+=("kandelo-man/$name")
done
install_package_man_pages mako-docs "$SRC" "${specs[@]}"
