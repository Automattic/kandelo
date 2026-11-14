#!/usr/bin/env bash
# Ship the `waybar` package's manual pages as waybar-docs.zip, a lazy
# archive mounted at /usr/.
#
# Upstream writes them in scdoc; meson.build runs scdoc over the pages of
# the modules it compiles. The list below is that rule applied to the
# modules build-waybar.sh compiles, cffi included, and the two templates
# take the build's SYSCONFDIR, /etc.
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$HERE/../../.." && pwd)"
# shellcheck source=/dev/null
source "$REPO_ROOT/scripts/install-package-man-pages.sh"
kandelo_man_pages_stage_source "$HERE"
SRC="$KANDELO_MAN_PAGES_SOURCE"
DATE="$(kandelo_man_pages_release_date "$WASM_POSIX_DEP_VERSION" 0.14.0=2025-08-08)"

templates=(
    man/waybar.5.scd.in
    man/waybar-styles.5.scd.in
)
for template in "${templates[@]}"; do
    page="${template%.in}"
    kandelo_man_pages_substitute "$SRC/$template" "$SRC/$page" @sysconfdir@=/etc
done

pages=(
    man/waybar.5.scd
    man/waybar-styles.5.scd
    man/waybar-custom.5.scd
    man/waybar-disk.5.scd
    man/waybar-idle-inhibitor.5.scd
    man/waybar-image.5.scd
    man/waybar-states.5.scd
    man/waybar-menu.5.scd
    man/waybar-temperature.5.scd
    man/waybar-clock.5.scd
    man/waybar-cffi.5.scd
    man/waybar-sway-language.5.scd
    man/waybar-sway-mode.5.scd
    man/waybar-sway-scratchpad.5.scd
    man/waybar-sway-window.5.scd
    man/waybar-sway-workspaces.5.scd
    man/waybar-wlr-taskbar.5.scd
    man/waybar-river-layout.5.scd
    man/waybar-river-mode.5.scd
    man/waybar-river-tags.5.scd
    man/waybar-river-window.5.scd
    man/waybar-dwl-tags.5.scd
    man/waybar-dwl-window.5.scd
    man/waybar-hyprland-language.5.scd
    man/waybar-hyprland-submap.5.scd
    man/waybar-hyprland-window.5.scd
    man/waybar-hyprland-workspaces.5.scd
    man/waybar-niri-language.5.scd
    man/waybar-niri-window.5.scd
    man/waybar-niri-workspaces.5.scd
)
specs=()
for page in "${pages[@]}"; do
    name="$(basename "$page" .scd)"
    kandelo_man_pages_scdoc "$DATE" "$SRC/$page" "$SRC/kandelo-man/$name"
    specs+=("kandelo-man/$name")
done
install_package_man_pages waybar-docs "$SRC" "${specs[@]}"
