#!/usr/bin/env bash
# Manual pages for Kandelo's game-play game launcher, as game-import-docs.zip, a lazy archive mounted at /usr/.
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
OWNER="${WASM_POSIX_DEP_GAME_IMPORT_DIR:?game-import dependency dir required}"

kandelo_man_pages_own_commands game-import-docs game-import 0.1.0 \
    game-play.1="$OWNER/game-play"
