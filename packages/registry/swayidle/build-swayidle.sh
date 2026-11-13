#!/usr/bin/env bash
#
# Build swayidle for wasm32-posix-kernel.
#
# swayidle is meson-only, so the port builds through upstream's meson build
# with the SDK cross file (sdk/meson/wasm32posix.ini), which links each
# executable through the SDK's strict link contract.
#
# Honors the dep-resolver build-script contract (see
# docs/package-management.md). When invoked via
# `cargo xtask build-deps resolve swayidle`, env vars are set by the
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
SRC_DIR="$KANDELO_PACKAGE_WORK_DIR/swayidle-src"

SWAYIDLE_VERSION="$WASM_POSIX_DEP_VERSION"
INSTALL_DIR="${WASM_POSIX_DEP_OUT_DIR:-$SCRIPT_DIR/swayidle-install}"
SOURCE_URL="$WASM_POSIX_DEP_SOURCE_URL"
SOURCE_SHA256="$WASM_POSIX_DEP_SOURCE_SHA256"

BUILD_DIR="$KANDELO_PACKAGE_WORK_DIR/swayidle-build"
CROSS_FILE="$REPO_ROOT/sdk/meson/wasm32posix.ini"

if ! command -v wasm32posix-cc &>/dev/null; then
    echo "ERROR: wasm32posix-cc not found. Enter scripts/dev-shell.sh." >&2
    exit 1
fi

DEP_PKG_CONFIG_PATH="${WASM_POSIX_DEP_PKG_CONFIG_PATH:?WASM_POSIX_DEP_PKG_CONFIG_PATH not set (must be invoked via cargo xtask build-deps resolve swayidle)}"
# In a cross build meson resolves the native wayland-scanner with the
# build machine's pkg-config and build.pkg_config_path.
SCANNER_PC_DIR="$(pkg-config --variable=pcfiledir wayland-scanner)" || {
    echo "ERROR: wayland-scanner not found by the build machine's pkg-config. Enter scripts/dev-shell.sh." >&2
    exit 1
}

# --- Stage verified source ---
if [ ! -d "$SRC_DIR" ]; then
    echo "==> Staging verified swayidle $SWAYIDLE_VERSION source..."
    kandelo_package_stage_verified_source swayidle "$SRC_DIR" \
        "${WASM_POSIX_DEP_SOURCE_DIR:-}" "$SOURCE_URL" "$SOURCE_SHA256" \
        "$KANDELO_PACKAGE_WORK_DIR"
fi

rm -rf "$BUILD_DIR"
# The resolver-created output directory is itself publication authority, so
# a recipe must populate that inode rather than delete and recreate it.
if [ -n "${WASM_POSIX_DEP_OUT_DIR:-}" ]; then
    if [ -n "$(find "$INSTALL_DIR" -mindepth 1 -print -quit)" ]; then
        echo "ERROR: swayidle resolver output directory must start empty" >&2
        exit 1
    fi
else
    rm -rf "$INSTALL_DIR"
fi
mkdir -p "$INSTALL_DIR"

echo "==> Configuring swayidle $SWAYIDLE_VERSION for wasm32..."
PKG_CONFIG_PATH="$DEP_PKG_CONFIG_PATH" meson setup "$BUILD_DIR" "$SRC_DIR" \
    --cross-file "$CROSS_FILE" \
    --prefix /usr \
    -Dbuild.pkg_config_path="$SCANNER_PC_DIR" \
    -Dwrap_mode=nodownload \
    -Dbuildtype=plain \
    -Doptimization=2 \
    -Dwerror=false \
    -Dlogind=disabled \
    -Dman-pages=disabled \
    -Dzsh-completions=false \
    -Dbash-completions=false \
    -Dfish-completions=false

echo "==> Building swayidle..."
ninja -C "$BUILD_DIR" swayidle

# A resolver caller owns the declared work and output roots. Keep the
# reviewed checkout read-only and suppress the developer-only local mirror.
if [ -n "${WASM_POSIX_DEP_WORK_DIR:-}" ] && [ -n "${WASM_POSIX_DEP_OUT_DIR:-}" ]; then
    export WASM_POSIX_INSTALL_LOCAL_MIRROR=0
    # swayidle forks the commands it runs on a timeout.
    export WASM_POSIX_INSTALL_FORK_INSTRUMENTATION=auto
fi
source "$REPO_ROOT/scripts/install-local-binary.sh"
cp "$BUILD_DIR/swayidle" "$BUILD_DIR/swayidle.wasm"
install_local_binary swayidle "$BUILD_DIR/swayidle.wasm" swayidle.wasm

echo "==> swayidle $SWAYIDLE_VERSION build complete!"
