#!/usr/bin/env bash
# Ship the `labwc` package's manual pages as labwc-docs.zip, a lazy
# archive mounted at /usr/. Upstream writes them in scdoc;
# docs/meson.build runs scdoc over the list below.
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$HERE/../../.." && pwd)"
# shellcheck source=/dev/null
source "$REPO_ROOT/scripts/install-package-man-pages.sh"
kandelo_man_pages_stage_source "$HERE"
SRC="$KANDELO_MAN_PAGES_SOURCE"
kandelo_man_pages_build_scdoc
DATE="$(kandelo_man_pages_release_date "$WASM_POSIX_DEP_VERSION" 0.20.2=2026-08-21)"

pages=(
    docs/labwc.1.scd
    docs/labwc-actions.5.scd
    docs/labwc-config.5.scd
    docs/labwc-menu.5.scd
    docs/labwc-theme.5.scd
    docs/labnag.1.scd
)
specs=()
for page in "${pages[@]}"; do
    name="$(basename "$page" .scd)"
    kandelo_man_pages_scdoc "$DATE" "$SRC/$page" "$SRC/kandelo-man/$name"
    specs+=("kandelo-man/$name")
done
install_package_man_pages labwc-docs "$SRC" "${specs[@]}"
