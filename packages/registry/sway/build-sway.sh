#!/usr/bin/env bash
#
# Build sway, swaymsg, swaybar and swaynag for wasm32-posix-kernel.
#
# sway is meson-only, so the port builds through upstream's meson build
# with the SDK cross file (sdk/meson/wasm32posix.ini), which links each
# executable through the SDK's strict link contract.
#
# Honors the dep-resolver build-script contract (see
# docs/package-management.md). When invoked via
# `cargo xtask build-deps resolve sway`, env vars are set by the
# resolver:
#
#     WASM_POSIX_DEP_OUT_DIR          # install prefix
#     WASM_POSIX_DEP_VERSION          # upstream version
#     WASM_POSIX_DEP_SOURCE_URL       # tarball URL
#     WASM_POSIX_DEP_SOURCE_SHA256    # expected sha256 of the tarball
#     WASM_POSIX_DEP_PKG_CONFIG_PATH  # every transitive dep's lib/pkgconfig

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"
source "$REPO_ROOT/scripts/package-build-roots.sh"
source "$REPO_ROOT/sdk/activate.sh"
kandelo_package_load_source_metadata "$SCRIPT_DIR"
# shellcheck source=/dev/null
kandelo_package_prepare_build_roots "$SCRIPT_DIR" wasm32
SRC_DIR="$KANDELO_PACKAGE_WORK_DIR/sway-src"

SWAY_VERSION="$WASM_POSIX_DEP_VERSION"
INSTALL_DIR="${WASM_POSIX_DEP_OUT_DIR:-$SCRIPT_DIR/sway-install}"
SOURCE_URL="$WASM_POSIX_DEP_SOURCE_URL"
SOURCE_SHA256="$WASM_POSIX_DEP_SOURCE_SHA256"

BUILD_DIR="$KANDELO_PACKAGE_WORK_DIR/sway-build"
CROSS_FILE="$REPO_ROOT/sdk/meson/wasm32posix.ini"

if ! command -v wasm32posix-cc &>/dev/null; then
    echo "ERROR: wasm32posix-cc not found. Enter scripts/dev-shell.sh." >&2
    exit 1
fi

DEP_PKG_CONFIG_PATH="${WASM_POSIX_DEP_PKG_CONFIG_PATH:?WASM_POSIX_DEP_PKG_CONFIG_PATH not set (must be invoked via cargo xtask build-deps resolve sway)}"
# wlroots' public headers include <wayland-protocols/*-enum.h>. The
# data-only wayland-protocols.pc carries no Cflags (distros install under
# a default include path), so the include directory is passed directly.
WAYLAND_PROTOCOLS_INCLUDE="${WASM_POSIX_DEP_WAYLAND_PROTOCOLS_DIR:?WASM_POSIX_DEP_WAYLAND_PROTOCOLS_DIR not set}/include"

# In a cross build meson resolves the native wayland-scanner with the
# build machine's pkg-config and build.pkg_config_path.
SCANNER_PC_DIR="$(pkg-config --variable=pcfiledir wayland-scanner)" || {
    echo "ERROR: wayland-scanner not found by the build machine's pkg-config. Enter scripts/dev-shell.sh." >&2
    exit 1
}

# --- Stage verified source ---
if [ ! -d "$SRC_DIR" ]; then
    echo "==> Staging verified sway $SWAY_VERSION source..."
    kandelo_package_stage_verified_source sway "$SRC_DIR" \
        "${WASM_POSIX_DEP_SOURCE_DIR:-}" "$SOURCE_URL" "$SOURCE_SHA256" \
        "$KANDELO_PACKAGE_WORK_DIR"

    for patch_file in "$SCRIPT_DIR"/patches/*.patch; do
        echo "==> Applying $(basename "$patch_file")..."
        kandelo_package_git_apply_patch "$SRC_DIR" "$patch_file"
    done
fi

bash "$SCRIPT_DIR/tests/check-status-line-eof.sh" \
    "$SRC_DIR/swaybar/status_line.c" "$KANDELO_PACKAGE_WORK_DIR/status-line-eof-test"

rm -rf "$BUILD_DIR"
# The resolver-created output directory is itself publication authority, so
# a recipe must populate that inode rather than delete and recreate it.
if [ -n "${WASM_POSIX_DEP_OUT_DIR:-}" ]; then
    if [ -n "$(find "$INSTALL_DIR" -mindepth 1 -print -quit)" ]; then
        echo "ERROR: sway resolver output directory must start empty" >&2
        exit 1
    fi
else
    rm -rf "$INSTALL_DIR"
fi
mkdir -p "$INSTALL_DIR"

# sway compiles SYSCONFDIR into the binary and reads its default config
# from there, so prefix and sysconfdir name guest paths.
#
# Kandelo links every library statically into one module, so a global
# symbol a shared library would keep private meets the program's own
# symbol of the same name. sway defines expand_path and list_insert;
# libxkbcommon and libinput define internal functions with those names
# and other signatures. wasm-ld links the mismatch with only a warning
# and turns the library's calls into traps, so sway's two are renamed.
SWAY_C_ARGS="-I$WAYLAND_PROTOCOLS_INCLUDE -Dexpand_path=sway_expand_path -Dlist_insert=sway_list_insert"
echo "==> Configuring sway $SWAY_VERSION for wasm32..."
PKG_CONFIG_PATH="$DEP_PKG_CONFIG_PATH" meson setup "$BUILD_DIR" "$SRC_DIR" \
    --cross-file "$CROSS_FILE" \
    --prefix /usr \
    --sysconfdir /etc \
    -Dbuild.pkg_config_path="$SCANNER_PC_DIR" \
    -Dwrap_mode=nodownload \
    -Dbuildtype=plain \
    -Doptimization=2 \
    -Dwerror=false \
    -Dc_args="$SWAY_C_ARGS" \
    -Dtray=disabled \
    -Dgdk-pixbuf=disabled \
    -Dman-pages=disabled \
    -Dzsh-completions=false \
    -Dbash-completions=false \
    -Dfish-completions=false

echo "==> Building sway..."
ninja -C "$BUILD_DIR" sway/sway swaymsg/swaymsg swaybar/swaybar swaynag/swaynag

# A resolver caller owns the declared work and output roots. Keep the
# reviewed checkout read-only and suppress the developer-only local mirror.
if [ -n "${WASM_POSIX_DEP_WORK_DIR:-}" ] && [ -n "${WASM_POSIX_DEP_OUT_DIR:-}" ]; then
    export WASM_POSIX_INSTALL_LOCAL_MIRROR=0
    export WASM_POSIX_INSTALL_FORK_INSTRUMENTATION=auto
fi
source "$REPO_ROOT/scripts/install-local-binary.sh"
for program in sway swaymsg swaybar swaynag; do
    cp "$BUILD_DIR/$program/$program" "$BUILD_DIR/$program.wasm"
    install_local_binary sway "$BUILD_DIR/$program.wasm" "$program.wasm"
done
# The artifact keeps an extension: the browser dev server (Vite) serves an
# extensionless file as a JavaScript module, not as its bytes.
install_local_runtime_file sway "$BUILD_DIR/config" sway.conf
# The default config's `output * bg` names this wallpaper; swaybg draws it.
install_local_runtime_file sway \
    "$SRC_DIR/assets/Sway_Wallpaper_Blue_1920x1080.png" Sway_Wallpaper_Blue_1920x1080.png
install_local_runtime_file sway \
    "$WASM_POSIX_DEP_XKEYBOARD_CONFIG_DIR/share/xkeyboard-config.zip" xkeyboard-config.zip
install_local_runtime_file sway \
    "$WASM_POSIX_DEP_LIBINPUT_DIR/share/libinput-quirks.zip" libinput-quirks.zip

echo "==> sway $SWAY_VERSION build complete!"
