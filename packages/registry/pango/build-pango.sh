#!/usr/bin/env bash
#
# Build pango (libpango-1.0.a, libpangoft2-1.0.a, libpangocairo-1.0.a)
# for wasm32-posix-kernel.
#
# pango is meson-only since 1.43, so the port builds through upstream's
# meson build with the SDK cross file (sdk/meson/wasm32posix.ini).
# Backends: fontconfig/freetype fonts, cairo rendering; no Xft, no
# libthai, no introspection.
#
# Honors the dep-resolver build-script contract (see
# docs/package-management.md). When invoked via
# `cargo xtask build-deps resolve pango`, env vars are set by the
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
# shellcheck source=/dev/null
source "$REPO_ROOT/scripts/package-build-roots.sh"
# WHY: two resolves of this recipe can run at once in one checkout (two
# test files missing the cache together). Each keeps its source and build
# tree under its own resolver work root so neither deletes the other's.
# A standalone run keeps them beside this script.
kandelo_package_prepare_build_roots "$SCRIPT_DIR" wasm32
SRC_DIR="$KANDELO_PACKAGE_WORK_DIR/pango-src"

PANGO_VERSION="${WASM_POSIX_DEP_VERSION:-1.56.4}"
PANGO_SERIES="${PANGO_VERSION%.*}"
INSTALL_DIR="${WASM_POSIX_DEP_OUT_DIR:-$SCRIPT_DIR/pango-install}"
SOURCE_URL="${WASM_POSIX_DEP_SOURCE_URL:-https://download.gnome.org/sources/pango/${PANGO_SERIES}/pango-${PANGO_VERSION}.tar.xz}"
SOURCE_SHA256="${WASM_POSIX_DEP_SOURCE_SHA256:-17065e2fcc5f5a5bdbffc884c956bfc7c451a96e8c4fb2f8ad837c6413cb5a01}"

BUILD_DIR="$KANDELO_PACKAGE_WORK_DIR/pango-build"
CROSS_FILE="$REPO_ROOT/sdk/meson/wasm32posix.ini"

if ! command -v wasm32posix-cc &>/dev/null; then
    echo "ERROR: wasm32posix-cc not found. Enter scripts/dev-shell.sh." >&2
    exit 1
fi

# Static meson lookups follow Requires.private, so pkg-config needs the
# whole dependency closure (cairo -> pixman, fontconfig -> libxml2, ...),
# which the resolver composes.
DEP_PKG_CONFIG_PATH="${WASM_POSIX_DEP_PKG_CONFIG_PATH:?WASM_POSIX_DEP_PKG_CONFIG_PATH not set (must be invoked via cargo xtask build-deps resolve pango)}"

# --- Stage verified source ---
if [ ! -d "$SRC_DIR" ]; then
    echo "==> Staging verified pango $PANGO_VERSION source..."
    kandelo_package_stage_verified_source pango "$SRC_DIR" \
        "${WASM_POSIX_DEP_SOURCE_DIR:-}" "$SOURCE_URL" "$SOURCE_SHA256" \
        "$KANDELO_PACKAGE_WORK_DIR"
    # Route arity-changing casts (one-argument free/copy functions passed
    # as GFunc/GCopyFunc) through correctly typed wrappers. Native ABIs
    # tolerate the extra argument; wasm's typed call_indirect traps on it.
    patch -d "$SRC_DIR" -p1 < "$SCRIPT_DIR/src/wasm-callback-arity.patch"
fi

# Fresh build dir each run — meson bakes --prefix into the build tree.
rm -rf "$BUILD_DIR"
# The resolver-created output directory is itself publication authority, so
# a recipe must populate that inode rather than delete and recreate it.
if [ -n "${WASM_POSIX_DEP_OUT_DIR:-}" ]; then
    if [ -n "$(find "$INSTALL_DIR" -mindepth 1 -print -quit)" ]; then
        echo "ERROR: pango resolver output directory must start empty" >&2
        exit 1
    fi
else
    rm -rf "$INSTALL_DIR"
fi

echo "==> Configuring pango $PANGO_VERSION for wasm32..."
PKG_CONFIG_PATH="$DEP_PKG_CONFIG_PATH" meson setup "$BUILD_DIR" "$SRC_DIR" \
    --cross-file "$CROSS_FILE" \
    --prefix "$INSTALL_DIR" \
    --libdir lib \
    -Dbuildtype=plain \
    -Doptimization=2 \
    -Dfontconfig=enabled \
    -Dfreetype=enabled \
    -Dcairo=enabled \
    -Dxft=disabled \
    -Dlibthai=disabled \
    -Dsysprof=disabled \
    -Dintrospection=disabled \
    -Ddocumentation=false \
    -Dgtk_doc=false \
    -Dman-pages=false \
    -Dbuild-testsuite=false \
    -Dbuild-examples=false

echo "==> Building pango..."
ninja -C "$BUILD_DIR"

echo "==> Installing to $INSTALL_DIR..."
meson install -C "$BUILD_DIR" --no-rebuild

# Upstream always builds and installs pango-view, pango-list and
# pango-segmentation. This is a library package: its declared outputs are
# the archives, headers and .pc files. Shipping a program needs a program
# package (VFS outputs, ABI stamp), so the tools are not published here.
rm -rf "$INSTALL_DIR/bin"

for lib in libpango-1.0.a libpangoft2-1.0.a libpangocairo-1.0.a; do
    if [ ! -f "$INSTALL_DIR/lib/$lib" ]; then
        echo "ERROR: Build failed — library not found at $INSTALL_DIR/lib/$lib" >&2
        exit 1
    fi
done

echo "==> pango $PANGO_VERSION build complete!"
ls -lh "$INSTALL_DIR/lib/"libpango*.a
