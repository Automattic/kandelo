#!/usr/bin/env bash
# Build the upstream core and real application menu in one executable.
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"
source "$REPO_ROOT/scripts/package-build-roots.sh"
source "$REPO_ROOT/sdk/activate.sh"
kandelo_package_load_source_metadata "$SCRIPT_DIR"
kandelo_package_prepare_build_roots "$SCRIPT_DIR" wasm32
SRC_DIR="$KANDELO_PACKAGE_WORK_DIR/sfwbar-src"
BUILD_DIR="$KANDELO_PACKAGE_WORK_DIR/sfwbar-build"
INSTALL_DIR="${WASM_POSIX_DEP_OUT_DIR:?invoke through the package resolver}"
DEP_PC="${WASM_POSIX_DEP_PKG_CONFIG_PATH:?missing declared dependencies}"
export PKG_CONFIG_PATH="$DEP_PC"
export LC_ALL=C

kandelo_package_stage_primary_source sfwbar "$SRC_DIR" "$KANDELO_PACKAGE_WORK_DIR"
for change in "$SCRIPT_DIR"/patches/*.patch; do
    patch --fuzz=0 -p1 -d "$SRC_DIR" < "$change"
done

# The real application menu links with the same GTK/GLib instance as the
# core. Trusted grouped execution cannot instantiate dynamic side modules.
meson setup "$BUILD_DIR" "$SRC_DIR" \
    --cross-file "$REPO_ROOT/sdk/meson/wasm32posix.ini" \
    --prefix /usr --libdir lib --datadir share \
    -Dwrap_mode=nofallback -Dbuildtype=plain -Doptimization=2 \
    -Dc_args=-fPIC -Dc_link_args=-Wl,--export=sfwbar_module_init \
    -Dstatic-appmenu=true -Dalsa=disabled -Dappmenu=disabled -Dbluez=disabled -Ddbus=disabled \
    -Diwd=disabled -Dnm=disabled -Dncenter=disabled -Dbsdctl=disabled \
    -Didle=disabled -Didleinhibit=disabled -Dnetwork=disabled \
    -Dpulse=disabled -Dpipewire=disabled -Dmpd=disabled -Dxkb=disabled \
    -Dbuild-docs=disabled
ninja -C "$BUILD_DIR" sfwbar

# Confirm that the built-in initializer was linked, not dropped as an
# unreferenced archive member. Runtime menu/launch checks remain required.
node "$SCRIPT_DIR/wasm-symbols.mjs" exports "$BUILD_DIR/sfwbar" > "$BUILD_DIR/exports.txt"
if ! grep -Fx sfwbar_module_init "$BUILD_DIR/exports.txt" >/dev/null; then
    echo "ERROR: built-in application menu initializer was not linked" >&2
    exit 1
fi

export WASM_POSIX_INSTALL_LOCAL_MIRROR=0
export WASM_POSIX_INSTALL_FORK_INSTRUMENTATION=auto
source "$REPO_ROOT/scripts/install-local-binary.sh"
cp "$BUILD_DIR/sfwbar" "$BUILD_DIR/sfwbar.wasm"
install_local_binary sfwbar "$BUILD_DIR/sfwbar.wasm" sfwbar.wasm
install_local_runtime_file sfwbar "$SRC_DIR/config/winops.widget" winops.widget
for artifact in sfwbar.config sway.config kandelo-sfwbar kandelo-terminal \
    kandelo-terminal.desktop scummvm.desktop; do
    install_local_runtime_file sfwbar "$SCRIPT_DIR/config/$artifact" "$artifact"
done
