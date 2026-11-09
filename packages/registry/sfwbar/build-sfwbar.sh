#!/usr/bin/env bash
# Build the upstream core and real dynamically loaded application-menu module.
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

# GTK and the core link statically. The appmenu implementation remains a real
# GModule side module: linking GTK into it would duplicate the main program's
# object/type state. Resolve its imports from the main executable, as ScummVM
# does for its engine plugins. No module loader or menu implementation changes.
meson setup "$BUILD_DIR" "$SRC_DIR" \
    --cross-file "$REPO_ROOT/sdk/meson/wasm32posix.ini" \
    --prefix /usr --libdir lib --datadir share \
    -Dwrap_mode=nofallback -Dbuildtype=plain -Doptimization=2 \
    -Dc_args=-fPIC -Dc_link_args=-Wl,--export-all \
    -Dalsa=disabled -Dappmenu=disabled -Dbluez=disabled -Ddbus=disabled \
    -Diwd=disabled -Dnm=disabled -Dncenter=disabled -Dbsdctl=disabled \
    -Didle=disabled -Didleinhibit=disabled -Dnetwork=disabled \
    -Dpulse=disabled -Dpipewire=disabled -Dmpd=disabled -Dxkb=disabled \
    -Dbuild-docs=disabled
ninja -C "$BUILD_DIR" sfwbar

read -r -a MODULE_CFLAGS <<< "$(wasm32posix-pkg-config --cflags \
    gtk+-3.0 gio-unix-2.0 gmodule-2.0 gtk-layer-shell-0 wayland-client json-c)"
wasm32posix-cc -O2 -fPIC -shared \
    -DGLIB_DISABLE_DEPRECATION_WARNINGS -DGDK_DISABLE_DEPRECATED \
    -DGTK_DISABLE_DEPRECATED -DGETTEXT_PACKAGE=\"sfwbar\" \
    -I"$SRC_DIR/src" -I"$BUILD_DIR" "${MODULE_CFLAGS[@]}" \
    "$SRC_DIR/modules/appmenu.c" -o "$BUILD_DIR/appmenu.so"

program_exports() {
    node "$SCRIPT_DIR/wasm-symbols.mjs" exports "$1"
}
missing_symbols() {
    node "$SCRIPT_DIR/wasm-symbols.mjs" missing "$1" "$2"
}
# Materialize decoder output before searching it: process substitution must
# not hide a parser failure and turn an incomplete inventory into success.
program_exports "$BUILD_DIR/appmenu.so" > "$BUILD_DIR/appmenu-exports.txt"
for symbol in sfwbar_module_signature sfwbar_module_version sfwbar_module_init; do
    if ! grep -Fx "$symbol" "$BUILD_DIR/appmenu-exports.txt" >/dev/null; then
        printf 'ERROR: application-menu module does not export %s\n' "$symbol" >&2
        exit 1
    fi
done
missing="$(missing_symbols "$BUILD_DIR/sfwbar" "$BUILD_DIR/appmenu.so")"
if [ -n "$missing" ]; then
    # Only real plugin imports force archive members into the executable.
    extra="$(printf -- '-Wl,-u,%s ' $missing)"
    meson configure "$BUILD_DIR" "-Dc_link_args=-Wl,--export-all $extra"
    ninja -C "$BUILD_DIR" sfwbar
fi
remaining="$(missing_symbols "$BUILD_DIR/sfwbar" "$BUILD_DIR/appmenu.so")"
if [ -n "$remaining" ]; then
    printf 'ERROR: application-menu imports missing from main executable:\n%s\n' "$remaining" >&2
    exit 1
fi

export WASM_POSIX_INSTALL_LOCAL_MIRROR=0
export WASM_POSIX_INSTALL_FORK_INSTRUMENTATION=auto
source "$REPO_ROOT/scripts/install-local-binary.sh"
cp "$BUILD_DIR/sfwbar" "$BUILD_DIR/sfwbar.wasm"
install_local_binary sfwbar "$BUILD_DIR/sfwbar.wasm" sfwbar.wasm
bash "$REPO_ROOT/scripts/run-wasm-fork-instrument.sh" \
    "$BUILD_DIR/appmenu.so" -o "$BUILD_DIR/appmenu-instrumented.so"
install_local_runtime_file sfwbar "$BUILD_DIR/appmenu-instrumented.so" appmenu.so
remaining="$(missing_symbols "$INSTALL_DIR/sfwbar.wasm" "$INSTALL_DIR/appmenu.so")"
if [ -n "$remaining" ]; then
    printf 'ERROR: instrumented application-menu imports are unresolved:\n%s\n' "$remaining" >&2
    exit 1
fi
install_local_runtime_file sfwbar "$SRC_DIR/config/winops.widget" winops.widget
for artifact in sfwbar.config sway.config kandelo-sfwbar kandelo-terminal \
    kandelo-terminal.desktop scummvm.desktop wayland-demo.desktop; do
    install_local_runtime_file sfwbar "$SCRIPT_DIR/config/$artifact" "$artifact"
done
