#!/usr/bin/env bash
# Manual pages for Kandelo's retro-run launcher and its emulators (fceumm, snes9x, genesis-plus-gx), as retro-emulators-docs.zip, a lazy archive mounted at /usr/.
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
OWNER="${WASM_POSIX_DEP_RETRO_EMULATORS_DIR:?retro-emulators dependency dir required}"

kandelo_man_pages_own_commands retro-emulators-docs retro-emulators 0.1.0 \
    retro-run.1="$OWNER/bin/retro-run" \
    fceumm.1="$OWNER/fceumm.wasm" \
    snes9x.1="$OWNER/snes9x.wasm" \
    genesis-plus-gx.1="$OWNER/genesis-plus-gx.wasm" \
    retro-nes.1='>fceumm.1' \
    retro-snes.1='>snes9x.1' \
    retro-genesis.1='>genesis-plus-gx.1'
