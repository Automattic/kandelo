#!/usr/bin/env bash
# Manual pages for Kandelo's qtgallery theme previewer, as qtgallery-docs.zip, a lazy archive mounted at /usr/.
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
OWNER="${WASM_POSIX_DEP_QTGALLERY_DIR:?qtgallery dependency dir required}"

kandelo_man_pages_own_commands qtgallery-docs qtgallery 0.1.0 \
    qtgallery.1="$OWNER/qtgallery.wasm"
