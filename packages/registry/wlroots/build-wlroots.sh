#!/usr/bin/env bash
#
# Build wlroots (libwlroots-0.20.a) for wasm32-posix-kernel.
#
# wlroots is meson-only, so the port builds through upstream's meson build
# with the SDK cross file (sdk/meson/wasm32posix.ini).
#
# Honors the dep-resolver build-script contract (see
# docs/package-management.md). When invoked via
# `cargo xtask build-deps resolve wlroots`, env vars are set by the
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
SRC_DIR="$KANDELO_PACKAGE_WORK_DIR/wlroots-src"

WLROOTS_VERSION="$WASM_POSIX_DEP_VERSION"
INSTALL_DIR="${WASM_POSIX_DEP_OUT_DIR:-$SCRIPT_DIR/wlroots-install}"
SOURCE_URL="$WASM_POSIX_DEP_SOURCE_URL"
SOURCE_SHA256="$WASM_POSIX_DEP_SOURCE_SHA256"

BUILD_DIR="$KANDELO_PACKAGE_WORK_DIR/wlroots-build"
CROSS_FILE="$REPO_ROOT/sdk/meson/wasm32posix.ini"

if ! command -v wasm32posix-cc &>/dev/null; then
    echo "ERROR: wasm32posix-cc not found. Enter scripts/dev-shell.sh." >&2
    exit 1
fi

DEP_PKG_CONFIG_PATH="${WASM_POSIX_DEP_PKG_CONFIG_PATH:?WASM_POSIX_DEP_PKG_CONFIG_PATH not set (must be invoked via cargo xtask build-deps resolve wlroots)}"
# wlroots' public headers include <wayland-protocols/*-enum.h>. The
# data-only wayland-protocols.pc carries no Cflags (distros install under
# a default include path), so the include directory is passed directly.
WAYLAND_PROTOCOLS_INCLUDE="${WASM_POSIX_DEP_WAYLAND_PROTOCOLS_DIR:?WASM_POSIX_DEP_WAYLAND_PROTOCOLS_DIR not set}/include"

# In a cross build meson resolves native dependencies (hwdata,
# wayland-scanner) with the build machine's pkg-config and
# build.pkg_config_path, not PKG_CONFIG_PATH.
NATIVE_PC_PATH=""
for native in hwdata wayland-scanner; do
    dir="$(pkg-config --variable=pcfiledir "$native")" || {
        echo "ERROR: $native not found by the build machine's pkg-config. Enter scripts/dev-shell.sh." >&2
        exit 1
    }
    NATIVE_PC_PATH="$NATIVE_PC_PATH${NATIVE_PC_PATH:+,}$dir"
done

# --- Stage verified source ---
if [ ! -d "$SRC_DIR" ]; then
    echo "==> Staging verified wlroots $WLROOTS_VERSION source..."
    kandelo_package_stage_verified_source wlroots "$SRC_DIR" \
        "${WASM_POSIX_DEP_SOURCE_DIR:-}" "$SOURCE_URL" "$SOURCE_SHA256" \
        "$KANDELO_PACKAGE_WORK_DIR"
fi

# Fresh build dir each run — meson bakes --prefix into the build tree.
rm -rf "$BUILD_DIR"
# The resolver-created output directory is itself publication authority, so
# a recipe must populate that inode rather than delete and recreate it.
if [ -n "${WASM_POSIX_DEP_OUT_DIR:-}" ]; then
    if [ -n "$(find "$INSTALL_DIR" -mindepth 1 -print -quit)" ]; then
        echo "ERROR: wlroots resolver output directory must start empty" >&2
        exit 1
    fi
else
    rm -rf "$INSTALL_DIR"
fi

echo "==> Configuring wlroots $WLROOTS_VERSION for wasm32..."
PKG_CONFIG_PATH="$DEP_PKG_CONFIG_PATH" meson setup "$BUILD_DIR" "$SRC_DIR" \
    --cross-file "$CROSS_FILE" \
    --prefix "$INSTALL_DIR" \
    --libdir lib \
    -Dbuild.pkg_config_path="$NATIVE_PC_PATH" \
    -Dwrap_mode=nodownload \
    -Dbuildtype=plain \
    -Doptimization=2 \
    -Dwerror=false \
    -Dc_args="-I$WAYLAND_PROTOCOLS_INCLUDE" \
    -Dbackends=drm,libinput \
    -Drenderers=gles2 \
    -Dallocators=gbm \
    -Dsession=enabled \
    -Dxwayland=disabled \
    -Dxcb-errors=disabled \
    -Dcolor-management=disabled \
    -Dlibliftoff=disabled \
    -Dexamples=false

echo "==> Building wlroots..."
ninja -C "$BUILD_DIR"

echo "==> Installing to $INSTALL_DIR..."
meson install -C "$BUILD_DIR" --no-rebuild

if [ ! -f "$INSTALL_DIR/lib/libwlroots-0.20.a" ]; then
    echo "ERROR: Build failed — library not found at $INSTALL_DIR/lib/libwlroots-0.20.a" >&2
    exit 1
fi

echo "==> wlroots $WLROOTS_VERSION build complete!"
ls -lh "$INSTALL_DIR/lib/libwlroots-0.20.a"
