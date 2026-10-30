#!/usr/bin/env bash
#
# Install wayland-protocols (protocol XML, enum headers, .pc) for
# wasm32-posix-kernel.
#
# wayland-protocols is meson-only and data-only: project() names no
# language, so nothing is compiled for the target. The build still runs
# through the SDK cross file (sdk/meson/wasm32posix.ini) like every meson
# package. Upstream generates include/wayland-protocols/*-enum.h with the
# build machine's wayland-scanner, found by a native
# dependency('wayland-scanner').
#
# Honors the dep-resolver build-script contract (see
# docs/package-management.md). When invoked via
# `cargo xtask build-deps resolve wayland-protocols`, env vars are set by
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
kandelo_package_load_source_metadata "$SCRIPT_DIR"
kandelo_package_prepare_build_roots "$SCRIPT_DIR" wasm32
SRC_DIR="$KANDELO_PACKAGE_WORK_DIR/wayland-protocols-src"

WP_VERSION="$WASM_POSIX_DEP_VERSION"
INSTALL_DIR="${WASM_POSIX_DEP_OUT_DIR:-$SCRIPT_DIR/wayland-protocols-install}"
SOURCE_URL="$WASM_POSIX_DEP_SOURCE_URL"
SOURCE_SHA256="$WASM_POSIX_DEP_SOURCE_SHA256"

BUILD_DIR="$KANDELO_PACKAGE_WORK_DIR/wayland-protocols-build"
CROSS_FILE="$REPO_ROOT/sdk/meson/wasm32posix.ini"

# In a cross build meson resolves native dependencies with the build
# machine's pkg-config and build.pkg_config_path, not PKG_CONFIG_PATH.
# Without wayland-scanner, upstream silently skips the enum headers.
if ! pkg-config --atleast-version=1.20.0 wayland-scanner; then
    echo "ERROR: native wayland-scanner >=1.20.0 is required. Enter scripts/dev-shell.sh." >&2
    exit 1
fi
SCANNER_PC_DIR="$(pkg-config --variable=pcfiledir wayland-scanner)" || {
    echo "ERROR: wayland-scanner not found by the build machine's pkg-config. Enter scripts/dev-shell.sh." >&2
    exit 1
}

# --- Stage verified source ---
if [ ! -d "$SRC_DIR" ]; then
    echo "==> Staging verified wayland-protocols $WP_VERSION source..."
    kandelo_package_stage_verified_source wayland-protocols "$SRC_DIR" \
        "${WASM_POSIX_DEP_SOURCE_DIR:-}" "$SOURCE_URL" "$SOURCE_SHA256" \
        "$KANDELO_PACKAGE_WORK_DIR"
fi

# Fresh build dir each run — meson bakes --prefix into the build tree.
rm -rf "$BUILD_DIR"
# The resolver-created output directory is itself publication authority, so
# a recipe must populate that inode rather than delete and recreate it.
if [ -n "${WASM_POSIX_DEP_OUT_DIR:-}" ]; then
    if [ -n "$(find "$INSTALL_DIR" -mindepth 1 -print -quit)" ]; then
        echo "ERROR: wayland-protocols resolver output directory must start empty" >&2
        exit 1
    fi
else
    rm -rf "$INSTALL_DIR"
fi

echo "==> Configuring wayland-protocols $WP_VERSION..."
meson setup "$BUILD_DIR" "$SRC_DIR" \
    --cross-file "$CROSS_FILE" \
    --prefix "$INSTALL_DIR" \
    -Dbuild.pkg_config_path="$SCANNER_PC_DIR" \
    -Dtests=false

echo "==> Generating enum headers..."
ninja -C "$BUILD_DIR"

echo "==> Installing to $INSTALL_DIR..."
meson install -C "$BUILD_DIR" --no-rebuild

# The resolver moves the output to its cache path after the build and
# rewrites the prefix only in lib/pkgconfig/*.pc. Upstream sets prefix
# explicitly, which pkgconfig.relocatable does not override, so derive it
# from the .pc file's own location instead.
sed -i.orig -e 's|^prefix=.*|prefix=${pcfiledir}/../..|' \
    "$INSTALL_DIR/share/pkgconfig/wayland-protocols.pc"
rm "$INSTALL_DIR/share/pkgconfig/wayland-protocols.pc.orig"

for f in share/pkgconfig/wayland-protocols.pc \
         share/wayland-protocols/stable/xdg-shell/xdg-shell.xml \
         include/wayland-protocols/xdg-shell-enum.h; do
    if [ ! -f "$INSTALL_DIR/$f" ]; then
        echo "ERROR: Install failed — $f not found under $INSTALL_DIR" >&2
        exit 1
    fi
done

echo "==> wayland-protocols $WP_VERSION install complete!"
