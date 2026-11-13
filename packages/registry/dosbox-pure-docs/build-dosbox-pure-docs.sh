#!/usr/bin/env bash
# Manual pages for Kandelo's dos-play launcher and dosbox-pure, its DOSBox Pure frontend, as dosbox-pure-docs.zip, a lazy archive mounted at /usr/.
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
OWNER="${WASM_POSIX_DEP_DOSBOX_PURE_DIR:?dosbox-pure dependency dir required}"

kandelo_man_pages_own_commands dosbox-pure-docs dosbox-pure 1.0-preview8 \
    dos-play.1="$OWNER/bin/dos-play" \
    dosbox-pure.1="$OWNER/dosbox-pure.wasm"
