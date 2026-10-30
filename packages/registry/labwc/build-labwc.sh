#!/usr/bin/env bash
# Build the pinned labwc release and labnag through the normal SDK/resolver.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"
source "$REPO_ROOT/scripts/package-build-roots.sh"
source "$REPO_ROOT/sdk/activate.sh"
kandelo_package_load_source_metadata "$SCRIPT_DIR"
kandelo_package_prepare_build_roots "$SCRIPT_DIR" wasm32
SRC_DIR="$KANDELO_PACKAGE_WORK_DIR/labwc-src"
BUILD_DIR="$KANDELO_PACKAGE_WORK_DIR/labwc-build"
INSTALL_DIR="${WASM_POSIX_DEP_OUT_DIR:-$KANDELO_PACKAGE_WORK_DIR/labwc-install}"
DEP_PKG_CONFIG_PATH="${WASM_POSIX_DEP_PKG_CONFIG_PATH:?invoke through the package resolver}"
WAYLAND_PROTOCOLS_INCLUDE="${WASM_POSIX_DEP_WAYLAND_PROTOCOLS_DIR:?missing direct wayland-protocols dependency}/include"
XKB_DATA="${WASM_POSIX_DEP_XKEYBOARD_CONFIG_DIR:?missing direct xkeyboard-config dependency}/share/xkeyboard-config.zip"
INPUT_DATA="${WASM_POSIX_DEP_LIBINPUT_DIR:?missing direct libinput dependency}/share/libinput-quirks.zip"

if ! pkg-config --atleast-version=1.24.0 wayland-scanner; then
    echo "ERROR: native wayland-scanner >=1.24.0 is required; enter scripts/dev-shell.sh" >&2
    exit 1
fi
SCANNER_PC_DIR="$(pkg-config --variable=pcfiledir wayland-scanner)"
# Upstream probes librsvg optionally even with svg=enabled. Require the
# declared target library here so a missing dependency cannot disable it.
PKG_CONFIG_PATH="$DEP_PKG_CONFIG_PATH" wasm32posix-pkg-config \
    --atleast-version=2.46.0 librsvg-2.0

kandelo_package_stage_primary_source labwc "$SRC_DIR" "$KANDELO_PACKAGE_WORK_DIR"
patch --fuzz=0 -p1 -d "$SRC_DIR" < "$SCRIPT_DIR/patches/0001-initial-scale-from-connector-density.patch"
rm -rf "$BUILD_DIR"
if [ -n "${WASM_POSIX_DEP_OUT_DIR:-}" ]; then
    if [ -n "$(find "$INSTALL_DIR" -mindepth 1 -print -quit)" ]; then
        echo "ERROR: labwc resolver output directory must start empty" >&2
        exit 1
    fi
else
    rm -rf "$INSTALL_DIR"
fi
mkdir -p "$INSTALL_DIR"

# Native Wayland, PNG/SVG decorations and labnag are enabled. Desktop icon
# lookup needs the separately unported libsfdo; Xwayland/systemd integration
# and translated catalogs are explicit optional feature selections.
PKG_CONFIG_PATH="$DEP_PKG_CONFIG_PATH" meson setup "$BUILD_DIR" "$SRC_DIR" \
    --cross-file "$REPO_ROOT/sdk/meson/wasm32posix.ini" \
    --prefix /usr --sysconfdir /etc \
    -Dbuild.pkg_config_path="$SCANNER_PC_DIR" \
    -Dwrap_mode=nofallback -Dbuildtype=plain -Doptimization=2 \
    -Dc_args="-I$WAYLAND_PROTOCOLS_INCLUDE" \
    -Dsvg=enabled -Dicon=disabled -Dxwayland=disabled -Dlabnag=enabled \
    -Dnls=disabled -Dsystemd-session=disabled -Dman-pages=disabled -Dtest=disabled
ninja -C "$BUILD_DIR" labwc clients/labnag

if [ -n "${WASM_POSIX_DEP_WORK_DIR:-}" ] && [ -n "${WASM_POSIX_DEP_OUT_DIR:-}" ]; then
    export WASM_POSIX_INSTALL_LOCAL_MIRROR=0
    export WASM_POSIX_INSTALL_FORK_INSTRUMENTATION=auto
fi
source "$REPO_ROOT/scripts/install-local-binary.sh"
cp "$BUILD_DIR/labwc" "$BUILD_DIR/labwc.wasm"
cp "$BUILD_DIR/clients/labnag" "$BUILD_DIR/labnag.wasm"
install_local_binary labwc "$BUILD_DIR/labwc.wasm" labwc.wasm
install_local_binary labwc "$BUILD_DIR/labnag.wasm" labnag.wasm
install_local_runtime_file labwc "$SCRIPT_DIR/config/rc.xml" labwc-rc.xml
install_local_runtime_file labwc "$SCRIPT_DIR/config/menu.xml" labwc-menu.xml
install_local_runtime_file labwc "$SCRIPT_DIR/config/foot.ini" labwc-foot.ini
install_local_runtime_file labwc "$XKB_DATA" xkeyboard-config.zip
install_local_runtime_file labwc "$INPUT_DATA" libinput-quirks.zip
