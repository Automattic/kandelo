#!/usr/bin/env bash
# Manual pages for Kandelo's freeciv-play launcher, as freeciv-play-docs.zip, a lazy archive mounted at /usr/.
# Kandelo writes these commands and their --help;
# kandelo_man_pages_own_commands lays out what each prints inside Kandelo.
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$HERE/../../.." && pwd)"
# shellcheck source=/dev/null
source "$REPO_ROOT/scripts/package-build-roots.sh"
kandelo_package_prepare_build_roots "$HERE" wasm32
# shellcheck source=/dev/null
source "$REPO_ROOT/scripts/install-package-man-pages.sh"
OWNER="${WASM_POSIX_DEP_FREECIV_BROWSER_BUNDLE_DIR:?freeciv-browser-bundle dependency dir required}"
# The bundle installs freeciv-play inside its freeciv.zip archive.
SCRIPT="$KANDELO_PACKAGE_WORK_DIR/freeciv-play"
unzip -p "$OWNER/freeciv.zip" bin/freeciv-play > "$SCRIPT"

kandelo_man_pages_own_commands freeciv-play-docs freeciv-browser-bundle 3.2.6 \
    freeciv-play.1="$SCRIPT"
