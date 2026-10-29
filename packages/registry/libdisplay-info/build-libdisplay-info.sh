#!/usr/bin/env bash
#
# Build libdisplay-info (libdisplay-info.a) for wasm32-posix-kernel.
#
# libdisplay-info is meson-only, so the port builds through upstream's
# meson build with the SDK cross file (sdk/meson/wasm32posix.ini). Its
# PNP vendor-name table is generated at build time from the build
# machine's hwdata (flake.nix), found by a native dependency('hwdata').
#
# Honors the dep-resolver build-script contract (see
# docs/package-management.md). When invoked via
# `cargo xtask build-deps resolve libdisplay-info`, env vars are set by
# the resolver:
#
#     WASM_POSIX_DEP_OUT_DIR          # install prefix
#     WASM_POSIX_DEP_VERSION          # upstream version
#     WASM_POSIX_DEP_SOURCE_URL       # tarball URL
#     WASM_POSIX_DEP_SOURCE_SHA256    # expected sha256 of the tarball

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"
source "$REPO_ROOT/scripts/package-build-roots.sh"
source "$REPO_ROOT/sdk/activate.sh"
kandelo_package_load_source_metadata "$SCRIPT_DIR"
kandelo_package_prepare_build_roots "$SCRIPT_DIR" wasm32
SRC_DIR="$KANDELO_PACKAGE_WORK_DIR/libdisplay-info-src"

DI_VERSION="$WASM_POSIX_DEP_VERSION"
INSTALL_DIR="${WASM_POSIX_DEP_OUT_DIR:-$SCRIPT_DIR/libdisplay-info-install}"
SOURCE_URL="$WASM_POSIX_DEP_SOURCE_URL"
SOURCE_SHA256="$WASM_POSIX_DEP_SOURCE_SHA256"

BUILD_DIR="$KANDELO_PACKAGE_WORK_DIR/libdisplay-info-build"
CROSS_FILE="$REPO_ROOT/sdk/meson/wasm32posix.ini"

if ! command -v wasm32posix-cc &>/dev/null; then
    echo "ERROR: wasm32posix-cc not found. Enter scripts/dev-shell.sh." >&2
    exit 1
fi

# In a cross build meson resolves native dependencies with the build
# machine's pkg-config and build.pkg_config_path, not PKG_CONFIG_PATH.
# Without hwdata, upstream falls back to /usr/share/hwdata/pnp.ids.
if ! pkg-config --atleast-version=0.300 hwdata; then
    echo "ERROR: native hwdata >=0.300 is required. Enter scripts/dev-shell.sh." >&2
    exit 1
fi
HWDATA_PC_DIR="$(pkg-config --variable=pcfiledir hwdata)" || {
    echo "ERROR: hwdata not found by the build machine's pkg-config. Enter scripts/dev-shell.sh." >&2
    exit 1
}

# --- Stage verified source ---
if [ ! -d "$SRC_DIR" ]; then
    echo "==> Staging verified libdisplay-info $DI_VERSION source..."
    kandelo_package_stage_verified_source libdisplay-info "$SRC_DIR" \
        "${WASM_POSIX_DEP_SOURCE_DIR:-}" "$SOURCE_URL" "$SOURCE_SHA256" \
        "$KANDELO_PACKAGE_WORK_DIR"
fi

# Fresh build dir each run — meson bakes --prefix into the build tree.
rm -rf "$BUILD_DIR"
# The resolver-created output directory is itself publication authority, so
# a recipe must populate that inode rather than delete and recreate it.
if [ -n "${WASM_POSIX_DEP_OUT_DIR:-}" ]; then
    if [ -n "$(find "$INSTALL_DIR" -mindepth 1 -print -quit)" ]; then
        echo "ERROR: libdisplay-info resolver output directory must start empty" >&2
        exit 1
    fi
else
    rm -rf "$INSTALL_DIR"
fi

# test/meson.build calls subproject('v4l-utils', required: false) for a
# reference edid-decode. The cross file's nofallback still lets an
# explicit subproject() clone its wrap; nodownload (upstream's own
# default) skips it.
echo "==> Configuring libdisplay-info $DI_VERSION for wasm32..."
meson setup "$BUILD_DIR" "$SRC_DIR" \
    --cross-file "$CROSS_FILE" \
    --prefix "$INSTALL_DIR" \
    --libdir lib \
    -Dbuild.pkg_config_path="$HWDATA_PC_DIR" \
    -Dwrap_mode=nodownload \
    -Dbuildtype=plain \
    -Doptimization=2

echo "==> Building libdisplay-info..."
ninja -C "$BUILD_DIR"

echo "==> Installing to $INSTALL_DIR..."
meson install -C "$BUILD_DIR" --no-rebuild

# Upstream always builds and installs di-edid-decode. This is a library
# package: its declared outputs are the archive, headers and .pc file.
rm -rf "$INSTALL_DIR/bin"

if [ ! -f "$INSTALL_DIR/lib/libdisplay-info.a" ]; then
    echo "ERROR: Build failed — library not found at $INSTALL_DIR/lib/libdisplay-info.a" >&2
    exit 1
fi

echo "==> libdisplay-info $DI_VERSION build complete!"
ls -lh "$INSTALL_DIR/lib/libdisplay-info.a"
