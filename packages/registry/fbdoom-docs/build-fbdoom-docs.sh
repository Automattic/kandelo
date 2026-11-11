#!/usr/bin/env bash
# Manual pages for Kandelo's fbdoom commands, as fbdoom-docs.zip, a lazy
# archive mounted at /usr/: fbdoom (the engine's launch wrapper),
# doom-launch and doom-activity. Kandelo writes these commands and their
# --help; kandelo_man_pages_own_commands lays out what each prints inside
# Kandelo.
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$HERE/../../.." && pwd)"
# shellcheck source=/dev/null
source "$REPO_ROOT/scripts/package-build-roots.sh"
kandelo_package_prepare_build_roots "$HERE" wasm32
# shellcheck source=/dev/null
source "$REPO_ROOT/scripts/install-package-man-pages.sh"
OWNER="${WASM_POSIX_DEP_FBDOOM_DIR:?fbdoom dependency dir required}"

kandelo_man_pages_own_commands fbdoom-docs fbdoom 0.1.0 \
    fbdoom.1="$OWNER/fbdoom-wrapper" \
    doom-launch.1="$OWNER/doom-launch" \
    doom-activity.1="$OWNER/doom-activity"
