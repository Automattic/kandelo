#!/usr/bin/env bash
# Ship the `sway` package's manual pages as sway-docs.zip, a lazy archive
# mounted at /usr/.
#
# Upstream writes them in scdoc; meson.build runs scdoc over the list
# below (the swaynag pages because the package builds swaynag). swaybar
# has no page of its own upstream: sway-bar(5) and swaybar-protocol(7)
# document it.
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$HERE/../../.." && pwd)"
# shellcheck source=/dev/null
source "$REPO_ROOT/scripts/install-package-man-pages.sh"
kandelo_man_pages_stage_source "$HERE"
SRC="$KANDELO_MAN_PAGES_SOURCE"
kandelo_man_pages_build_scdoc
DATE="$(kandelo_man_pages_release_date "$WASM_POSIX_DEP_VERSION" 1.12=2026-05-25)"

pages=(
    sway/sway.1.scd
    sway/sway.5.scd
    sway/sway-bar.5.scd
    sway/sway-input.5.scd
    sway/sway-ipc.7.scd
    sway/sway-output.5.scd
    swaybar/swaybar-protocol.7.scd
    swaymsg/swaymsg.1.scd
    swaynag/swaynag.1.scd
    swaynag/swaynag.5.scd
)
specs=()
for page in "${pages[@]}"; do
    name="$(basename "$page" .scd)"
    kandelo_man_pages_scdoc "$DATE" "$SRC/$page" "$SRC/kandelo-man/$name"
    specs+=("kandelo-man/$name")
done
install_package_man_pages sway-docs "$SRC" "${specs[@]}"
