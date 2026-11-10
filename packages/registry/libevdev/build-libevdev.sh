#!/usr/bin/env bash
#
# Build libevdev (libevdev.a) for wasm32-posix-kernel through upstream's
# meson build with the SDK cross file (sdk/meson/wasm32posix.ini).
#
# libevdev compiles against its own bundled Linux UAPI headers
# (include/linux/linux/), not the build host's. patches/0001 lets
# platforms other than Linux and FreeBSD reach that copy; the bundled
# input.h then includes <linux/types.h>, which the Kandelo sysroot does
# not ship, so src/linux-types.h stands in for it on a private include
# path.
#
# Honors the dep-resolver build-script contract (see
# docs/package-management.md). When invoked via
# `cargo xtask build-deps resolve libevdev`, env vars are set by the
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
SRC_DIR="$KANDELO_PACKAGE_WORK_DIR/libevdev-src"

LIBEVDEV_VERSION="$WASM_POSIX_DEP_VERSION"
INSTALL_DIR="${WASM_POSIX_DEP_OUT_DIR:-$SCRIPT_DIR/libevdev-install}"
SOURCE_URL="$WASM_POSIX_DEP_SOURCE_URL"
SOURCE_SHA256="$WASM_POSIX_DEP_SOURCE_SHA256"

BUILD_DIR="$KANDELO_PACKAGE_WORK_DIR/libevdev-build"
UAPI_DIR="$KANDELO_PACKAGE_WORK_DIR/libevdev-uapi"
CROSS_FILE="$REPO_ROOT/sdk/meson/wasm32posix.ini"

if ! command -v wasm32posix-cc &>/dev/null; then
    echo "ERROR: wasm32posix-cc not found. Enter scripts/dev-shell.sh." >&2
    exit 1
fi

# --- Stage verified source ---
if [ ! -d "$SRC_DIR" ]; then
    echo "==> Staging verified libevdev $LIBEVDEV_VERSION source..."
    kandelo_package_stage_verified_source libevdev "$SRC_DIR" \
        "${WASM_POSIX_DEP_SOURCE_DIR:-}" "$SOURCE_URL" "$SOURCE_SHA256" \
        "$KANDELO_PACKAGE_WORK_DIR"
    patch -d "$SRC_DIR" -p1 < "$SCRIPT_DIR/patches/0001-linux-uapi-headers-off-linux-and-freebsd.patch"
fi

# Fresh build dir each run — meson bakes --prefix into the build tree.
rm -rf "$BUILD_DIR" "$UAPI_DIR"
# The resolver-created output directory is itself publication authority, so
# a recipe must populate that inode rather than delete and recreate it.
if [ -n "${WASM_POSIX_DEP_OUT_DIR:-}" ]; then
    if [ -n "$(find "$INSTALL_DIR" -mindepth 1 -print -quit)" ]; then
        echo "ERROR: libevdev resolver output directory must start empty" >&2
        exit 1
    fi
else
    rm -rf "$INSTALL_DIR"
fi

mkdir -p "$UAPI_DIR/linux"
cp "$SCRIPT_DIR/src/linux-types.h" "$UAPI_DIR/linux/types.h"

echo "==> Configuring libevdev $LIBEVDEV_VERSION for wasm32..."
meson setup "$BUILD_DIR" "$SRC_DIR" \
    --cross-file "$CROSS_FILE" \
    --prefix "$INSTALL_DIR" \
    --libdir lib \
    -Dbuildtype=plain \
    -Doptimization=2 \
    -Dc_args="-I$UAPI_DIR" \
    -Dtests=disabled \
    -Dtools=disabled \
    -Ddocumentation=disabled

echo "==> Building libevdev..."
ninja -C "$BUILD_DIR"

# The devel tag installs the archive, the headers and libevdev.pc; the
# man page is not a library output.
echo "==> Installing to $INSTALL_DIR..."
meson install -C "$BUILD_DIR" --no-rebuild --tags devel

for output in \
    lib/libevdev.a \
    lib/pkgconfig/libevdev.pc \
    include/libevdev-1.0/libevdev/libevdev.h \
    include/libevdev-1.0/libevdev/libevdev-uinput.h
do
    if [ ! -f "$INSTALL_DIR/$output" ]; then
        echo "ERROR: Build failed — output not found at $INSTALL_DIR/$output" >&2
        exit 1
    fi
done

echo "==> libevdev $LIBEVDEV_VERSION build complete!"
ls -lh "$INSTALL_DIR/lib/libevdev.a"
