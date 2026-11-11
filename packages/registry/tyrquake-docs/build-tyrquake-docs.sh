#!/usr/bin/env bash
# Manual pages for Kandelo's Quake commands (quake, quake-activity, quake-data), as tyrquake-docs.zip, a lazy archive mounted at /usr/.
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
OWNER="${WASM_POSIX_DEP_TYRQUAKE_DIR:?tyrquake dependency dir required}"

kandelo_man_pages_own_commands tyrquake-docs tyrquake 0.71.0 \
    quake.1="$OWNER/quake-launch" \
    quake-activity.1="$OWNER/quake-activity" \
    quake-data.1="$OWNER/quake-data"
