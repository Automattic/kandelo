#!/usr/bin/env bash
#
# Build cage (cage.wasm) for wasm32-posix-kernel.
#
# cage is meson-only, so the port builds through upstream's meson build
# with the SDK cross file (sdk/meson/wasm32posix.ini), which links the
# executable through the SDK's strict link contract.
#
# Honors the dep-resolver build-script contract (see
# docs/package-management.md). When invoked via
# `cargo xtask build-deps resolve cage`, env vars are set by the
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
SRC_DIR="$KANDELO_PACKAGE_WORK_DIR/cage-src"

CAGE_VERSION="$WASM_POSIX_DEP_VERSION"
INSTALL_DIR="${WASM_POSIX_DEP_OUT_DIR:-$SCRIPT_DIR/cage-install}"

BUILD_DIR="$KANDELO_PACKAGE_WORK_DIR/cage-build"
CROSS_FILE="$REPO_ROOT/sdk/meson/wasm32posix.ini"

if ! command -v wasm32posix-cc &>/dev/null; then
    echo "ERROR: wasm32posix-cc not found. Enter scripts/dev-shell.sh." >&2
    exit 1
fi

DEP_PKG_CONFIG_PATH="${WASM_POSIX_DEP_PKG_CONFIG_PATH:?WASM_POSIX_DEP_PKG_CONFIG_PATH not set (must be invoked via cargo xtask build-deps resolve cage)}"
# wlroots' public headers include <wayland-protocols/*-enum.h>. The
# data-only wayland-protocols.pc carries no Cflags (distros install under
# a default include path), so the include directory is passed directly.
WAYLAND_PROTOCOLS_INCLUDE="${WASM_POSIX_DEP_WAYLAND_PROTOCOLS_DIR:?WASM_POSIX_DEP_WAYLAND_PROTOCOLS_DIR not set}/include"

# In a cross build meson resolves the native wayland-scanner with the
# build machine's pkg-config and build.pkg_config_path.
if ! pkg-config --atleast-version=1.20.0 wayland-scanner; then
    echo "ERROR: native wayland-scanner >=1.20.0 is required. Enter scripts/dev-shell.sh." >&2
    exit 1
fi
SCANNER_PC_DIR="$(pkg-config --variable=pcfiledir wayland-scanner)" || {
    echo "ERROR: wayland-scanner not found by the build machine's pkg-config. Enter scripts/dev-shell.sh." >&2
    exit 1
}

# --- Stage verified source ---
echo "==> Staging verified cage $CAGE_VERSION source..."
kandelo_package_stage_primary_source cage "$SRC_DIR" "$KANDELO_PACKAGE_WORK_DIR"
patch --fuzz=0 -p1 -d "$SRC_DIR" < "$SCRIPT_DIR/patches/0001-initial-scale-from-connector-density.patch"
bash "$SCRIPT_DIR/tests/check-output-scale.sh" "$SRC_DIR/output.c" "$KANDELO_PACKAGE_WORK_DIR/output-scale-control"

rm -rf "$BUILD_DIR"
# The resolver-created output directory is itself publication authority, so
# a recipe must populate that inode rather than delete and recreate it.
if [ -n "${WASM_POSIX_DEP_OUT_DIR:-}" ]; then
    if [ -n "$(find "$INSTALL_DIR" -mindepth 1 -print -quit)" ]; then
        echo "ERROR: cage resolver output directory must start empty" >&2
        exit 1
    fi
else
    rm -rf "$INSTALL_DIR"
fi
mkdir -p "$INSTALL_DIR"

echo "==> Configuring cage $CAGE_VERSION for wasm32..."
PKG_CONFIG_PATH="$DEP_PKG_CONFIG_PATH" meson setup "$BUILD_DIR" "$SRC_DIR" \
    --cross-file "$CROSS_FILE" \
    --prefix "$INSTALL_DIR" \
    -Dbuild.pkg_config_path="$SCANNER_PC_DIR" \
    -Dwrap_mode=nodownload \
    -Dbuildtype=plain \
    -Doptimization=2 \
    -Dwerror=false \
    -Dc_args="-I$WAYLAND_PROTOCOLS_INCLUDE" \
    -Dman-pages=disabled

echo "==> Building cage..."
ninja -C "$BUILD_DIR" cage

echo "==> Instrumenting fork paths..."
bash "$REPO_ROOT/scripts/run-wasm-fork-instrument.sh" \
    "$BUILD_DIR/cage" -o "$BUILD_DIR/cage.wasm"

cp "$BUILD_DIR/cage.wasm" "$INSTALL_DIR/cage.wasm"

# A resolver caller owns the declared work and output roots. Keep the
# reviewed checkout read-only and suppress the developer-only local mirror.
if [ -n "${WASM_POSIX_DEP_WORK_DIR:-}" ] && [ -n "${WASM_POSIX_DEP_OUT_DIR:-}" ]; then
    export WASM_POSIX_INSTALL_LOCAL_MIRROR=0
    export WASM_POSIX_INSTALL_FORK_INSTRUMENTATION=auto
fi
source "$REPO_ROOT/scripts/install-local-binary.sh"
install_local_binary cage "$BUILD_DIR/cage.wasm"
install_local_runtime_file cage \
    "$WASM_POSIX_DEP_XKEYBOARD_CONFIG_DIR/share/xkeyboard-config.zip" xkeyboard-config.zip
install_local_runtime_file cage \
    "$WASM_POSIX_DEP_LIBINPUT_DIR/share/libinput-quirks.zip" libinput-quirks.zip

echo "==> cage $CAGE_VERSION build complete!"
ls -lh "$INSTALL_DIR/cage.wasm"
