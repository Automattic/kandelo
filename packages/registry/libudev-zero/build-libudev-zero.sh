#!/usr/bin/env bash
#
# Build libudev-zero (libudev.a) for wasm32-posix-kernel.
#
# Builds through upstream's meson build with the SDK cross file
# (sdk/meson/wasm32posix.ini), which selects static libraries. The
# library reads /sys and the uevent netlink socket at run time; it has
# no build-time dependencies.
#
# Honors the dep-resolver build-script contract (see
# docs/package-management.md). When invoked via
# `cargo xtask build-deps resolve libudev-zero`, env vars are set by the
# resolver:
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
# shellcheck source=/dev/null
kandelo_package_prepare_build_roots "$SCRIPT_DIR" wasm32
SRC_DIR="$KANDELO_PACKAGE_WORK_DIR/libudev-zero-src"

LIBUDEV_ZERO_VERSION="$WASM_POSIX_DEP_VERSION"
INSTALL_DIR="${WASM_POSIX_DEP_OUT_DIR:-$SCRIPT_DIR/libudev-zero-install}"

BUILD_DIR="$KANDELO_PACKAGE_WORK_DIR/libudev-zero-build"
CROSS_FILE="$REPO_ROOT/sdk/meson/wasm32posix.ini"

if ! command -v wasm32posix-cc &>/dev/null; then
    echo "ERROR: wasm32posix-cc not found. Enter scripts/dev-shell.sh." >&2
    exit 1
fi

# --- Stage verified source ---
echo "==> Staging verified libudev-zero $LIBUDEV_ZERO_VERSION source..."
kandelo_package_stage_primary_source libudev-zero "$SRC_DIR" "$KANDELO_PACKAGE_WORK_DIR"

# Fresh build dir each run — meson bakes --prefix into the build tree.
rm -rf "$BUILD_DIR"
# The resolver-created output directory is itself publication authority, so
# a recipe must populate that inode rather than delete and recreate it.
if [ -n "${WASM_POSIX_DEP_OUT_DIR:-}" ]; then
    if [ -n "$(find "$INSTALL_DIR" -mindepth 1 -print -quit)" ]; then
        echo "ERROR: libudev-zero resolver output directory must start empty" >&2
        exit 1
    fi
else
    rm -rf "$INSTALL_DIR"
fi

# The usb.ids path is read at run time inside the VFS, so it names the
# guest path, not the install prefix. A static archive carries no symbol
# versions, so the version script is not probed.
echo "==> Configuring libudev-zero $LIBUDEV_ZERO_VERSION for wasm32..."
meson setup "$BUILD_DIR" "$SRC_DIR" \
    --cross-file "$CROSS_FILE" \
    --prefix "$INSTALL_DIR" \
    --libdir lib \
    -Dbuildtype=plain \
    -Doptimization=2 \
    -Ddefault_library=static \
    -Dsymbol-versioning=disabled \
    -Dusb-ids-path=/usr/share/hwdata/usb.ids

echo "==> Building libudev-zero..."
ninja -C "$BUILD_DIR"

echo "==> Installing to $INSTALL_DIR..."
meson install -C "$BUILD_DIR" --no-rebuild

for output in lib/libudev.a include/libudev.h lib/pkgconfig/libudev.pc; do
    if [ ! -f "$INSTALL_DIR/$output" ]; then
        echo "ERROR: Build failed — output not found at $INSTALL_DIR/$output" >&2
        exit 1
    fi
done

echo "==> libudev-zero $LIBUDEV_ZERO_VERSION build complete!"
ls -lh "$INSTALL_DIR/lib/libudev.a"
