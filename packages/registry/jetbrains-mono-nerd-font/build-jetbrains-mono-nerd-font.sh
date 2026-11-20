#!/usr/bin/env bash
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$HERE/../../.." && pwd)"
source "$REPO_ROOT/scripts/package-build-roots.sh"
kandelo_package_load_source_metadata "$HERE"
kandelo_package_prepare_build_roots "$HERE" wasm32
WORK="$KANDELO_PACKAGE_WORK_DIR"
SRC="$WORK/font-src"
STAGING="$WORK/font-staging"

kandelo_package_stage_primary_source jetbrains-mono-nerd-font "$SRC" "$WORK"

mkdir -p "$STAGING"
for file in JetBrainsMonoNerdFont-Regular.ttf JetBrainsMonoNerdFont-Bold.ttf \
    JetBrainsMonoNerdFont-Italic.ttf JetBrainsMonoNerdFont-BoldItalic.ttf OFL.txt; do
    [ -f "$SRC/$file" ] || { echo "build-jetbrains-mono-nerd-font: missing $file" >&2; exit 1; }
    cp "$SRC/$file" "$STAGING/$file"
done

bash "$REPO_ROOT/images/vfs/scripts/create-deterministic-zip.sh" "$STAGING" \
    "$WORK/jetbrains-mono-nerd-font.zip"
if [ -n "${WASM_POSIX_DEP_OUT_DIR:-}" ]; then
    export WASM_POSIX_INSTALL_LOCAL_MIRROR=0
    export WASM_POSIX_INSTALL_FORK_INSTRUMENTATION=disabled
fi
source "$REPO_ROOT/scripts/install-local-binary.sh"
install_local_binary jetbrains-mono-nerd-font "$WORK/jetbrains-mono-nerd-font.zip" \
    jetbrains-mono-nerd-font.zip
