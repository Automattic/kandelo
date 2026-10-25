#!/usr/bin/env bash
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$HERE/../../.." && pwd)"
source "$REPO_ROOT/scripts/package-build-roots.sh"
kandelo_package_prepare_build_roots "$HERE" wasm32
WORK="$KANDELO_PACKAGE_WORK_DIR"
OUT="${WASM_POSIX_DEP_OUT_DIR:?missing output directory}"
DEP="${WASM_POSIX_DEP_FREECIV_DIR:?missing freeciv dependency}"
STAGE="$WORK/bundle"
mkdir -p "$STAGE/bin" "$STAGE/libexec/freeciv" "$STAGE/share/freeciv-kandelo"
unzip -q "$DEP/freeciv-data.zip" -d "$STAGE"
install -m755 "$DEP/freeciv-sdl2.wasm" "$STAGE/libexec/freeciv/client.wasm"
install -m755 "$DEP/freeciv-server.wasm" "$STAGE/libexec/freeciv/server.wasm"
for script in freeciv freeciv-server freeciv-play; do
    install -m755 "$HERE/$script" "$STAGE/bin/$script"
done
ln -s freeciv "$STAGE/bin/freeciv-sdl2"
install -m644 "$HERE/host.serv" "$STAGE/share/freeciv-kandelo/host.serv"
install -m644 "$HERE/client-defaults" "$STAGE/share/freeciv-kandelo/client-defaults"
bash "$REPO_ROOT/images/vfs/scripts/create-deterministic-zip.sh" \
    "$STAGE" "$WORK/freeciv.zip"
export WASM_POSIX_INSTALL_LOCAL_MIRROR=0
export WASM_POSIX_INSTALL_FORK_INSTRUMENTATION=disabled
source "$REPO_ROOT/scripts/install-local-binary.sh"
install_local_binary freeciv-browser-bundle "$WORK/freeciv.zip" freeciv.zip

install_local_runtime_file freeciv-browser-bundle "${HERE}/sessions.json" sessions.json
