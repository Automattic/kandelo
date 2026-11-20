#!/usr/bin/env bash
#
# Build swaylock for wasm32-posix-kernel.
#
# swaylock is meson-only, so the port builds through upstream's meson build
# with the SDK cross file (sdk/meson/wasm32posix.ini), which links each
# executable through the SDK's strict link contract.
#
# Honors the dep-resolver build-script contract (see
# docs/package-management.md). When invoked via
# `cargo xtask build-deps resolve swaylock`, env vars are set by the
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
SRC_DIR="$KANDELO_PACKAGE_WORK_DIR/swaylock-src"

SWAYLOCK_VERSION="$WASM_POSIX_DEP_VERSION"
INSTALL_DIR="${WASM_POSIX_DEP_OUT_DIR:-$SCRIPT_DIR/swaylock-install}"
SOURCE_URL="$WASM_POSIX_DEP_SOURCE_URL"
SOURCE_SHA256="$WASM_POSIX_DEP_SOURCE_SHA256"

BUILD_DIR="$KANDELO_PACKAGE_WORK_DIR/swaylock-build"
CROSS_FILE="$REPO_ROOT/sdk/meson/wasm32posix.ini"

if ! command -v wasm32posix-cc &>/dev/null; then
    echo "ERROR: wasm32posix-cc not found. Enter scripts/dev-shell.sh." >&2
    exit 1
fi

DEP_PKG_CONFIG_PATH="${WASM_POSIX_DEP_PKG_CONFIG_PATH:?WASM_POSIX_DEP_PKG_CONFIG_PATH not set (must be invoked via cargo xtask build-deps resolve swaylock)}"
# In a cross build meson resolves the native wayland-scanner with the
# build machine's pkg-config and build.pkg_config_path.
SCANNER_PC_DIR="$(pkg-config --variable=pcfiledir wayland-scanner)" || {
    echo "ERROR: wayland-scanner not found by the build machine's pkg-config. Enter scripts/dev-shell.sh." >&2
    exit 1
}
# swaylock includes <cairo/cairo.h>, but cairo.pc names only
# ${includedir}/cairo. A /usr install puts ${includedir} on the default
# search path; each Kandelo dependency has its own prefix, so name it.
CAIRO_INCLUDE="$(PKG_CONFIG_PATH="$DEP_PKG_CONFIG_PATH" pkg-config --variable=includedir cairo)" || {
    echo "ERROR: cairo not found in the resolved dependencies" >&2
    exit 1
}

# --- Stage verified source ---
if [ ! -d "$SRC_DIR" ]; then
    echo "==> Staging verified swaylock $SWAYLOCK_VERSION source..."
    kandelo_package_stage_verified_source swaylock "$SRC_DIR" \
        "${WASM_POSIX_DEP_SOURCE_DIR:-}" "$SOURCE_URL" "$SOURCE_SHA256" \
        "$KANDELO_PACKAGE_WORK_DIR"
fi

rm -rf "$BUILD_DIR"
# The resolver-created output directory is itself publication authority, so
# a recipe must populate that inode rather than delete and recreate it.
if [ -n "${WASM_POSIX_DEP_OUT_DIR:-}" ]; then
    if [ -n "$(find "$INSTALL_DIR" -mindepth 1 -print -quit)" ]; then
        echo "ERROR: swaylock resolver output directory must start empty" >&2
        exit 1
    fi
else
    rm -rf "$INSTALL_DIR"
fi
mkdir -p "$INSTALL_DIR"

echo "==> Configuring swaylock $SWAYLOCK_VERSION for wasm32..."
PKG_CONFIG_PATH="$DEP_PKG_CONFIG_PATH" meson setup "$BUILD_DIR" "$SRC_DIR" \
    --cross-file "$CROSS_FILE" \
    --prefix /usr \
    -Dbuild.pkg_config_path="$SCANNER_PC_DIR" \
    -Dc_args="-I$CAIRO_INCLUDE" \
    -Dwrap_mode=nodownload \
    -Dbuildtype=plain \
    -Doptimization=2 \
    -Dwerror=false \
    -Dpam=disabled \
    -Dgdk-pixbuf=enabled \
    -Dman-pages=disabled \
    -Dzsh-completions=false \
    -Dbash-completions=false \
    -Dfish-completions=false

echo "==> Building swaylock..."
ninja -C "$BUILD_DIR" swaylock

# A resolver caller owns the declared work and output roots. Keep the
# reviewed checkout read-only and suppress the developer-only local mirror.
if [ -n "${WASM_POSIX_DEP_WORK_DIR:-}" ] && [ -n "${WASM_POSIX_DEP_OUT_DIR:-}" ]; then
    export WASM_POSIX_INSTALL_LOCAL_MIRROR=0
    # swaylock forks the child that checks the password.
    export WASM_POSIX_INSTALL_FORK_INSTRUMENTATION=auto
fi
source "$REPO_ROOT/scripts/install-local-binary.sh"
cp "$BUILD_DIR/swaylock" "$BUILD_DIR/swaylock.wasm"
install_local_binary swaylock "$BUILD_DIR/swaylock.wasm" swaylock.wasm

echo "==> swaylock $SWAYLOCK_VERSION build complete!"
