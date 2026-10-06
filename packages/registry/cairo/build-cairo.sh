#!/usr/bin/env bash
#
# Build cairo (libcairo.a + libcairo-gobject.a) for wasm32-posix-kernel.
#
# cairo is meson-only since 1.18, so the port builds through upstream's
# meson build with the SDK cross file (sdk/meson/wasm32posix.ini). Image
# surfaces per plan §4 (PR23): freetype/fontconfig fonts and png I/O;
# no X, no quartz/win32/dwrite. The pdf/ps/svg vector surfaces are on
# because GTK3 hard-requires cairo-pdf.h (print-to-file paths compile
# unconditionally); meson ties them, and the script surface, to the zlib
# feature.
#
# Honors the dep-resolver build-script contract (see
# docs/package-management.md). When invoked via
# `cargo xtask build-deps resolve cairo`, env vars are set by the
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
kandelo_package_load_source_metadata "$SCRIPT_DIR"
# shellcheck source=/dev/null
# WHY: two resolves of this recipe can run at once in one checkout (two
# test files missing the cache together). Each keeps its source and build
# tree under its own resolver work root so neither deletes the other's.
# A standalone run keeps them beside this script.
kandelo_package_prepare_build_roots "$SCRIPT_DIR" wasm32
SRC_DIR="$KANDELO_PACKAGE_WORK_DIR/cairo-src"

CAIRO_VERSION="$WASM_POSIX_DEP_VERSION"
INSTALL_DIR="${WASM_POSIX_DEP_OUT_DIR:-$SCRIPT_DIR/cairo-install}"
SOURCE_URL="$WASM_POSIX_DEP_SOURCE_URL"
SOURCE_SHA256="$WASM_POSIX_DEP_SOURCE_SHA256"

BUILD_DIR="$KANDELO_PACKAGE_WORK_DIR/cairo-build"
CROSS_FILE="$REPO_ROOT/sdk/meson/wasm32posix.ini"

if ! command -v wasm32posix-cc &>/dev/null; then
    echo "ERROR: wasm32posix-cc not found. Enter scripts/dev-shell.sh." >&2
    exit 1
fi

# Static meson lookups follow Requires.private, so pkg-config needs the
# whole dependency closure (fontconfig -> libxml2 -> libiconv, ...), which
# the resolver composes.
DEP_PKG_CONFIG_PATH="${WASM_POSIX_DEP_PKG_CONFIG_PATH:?WASM_POSIX_DEP_PKG_CONFIG_PATH not set (must be invoked via cargo xtask build-deps resolve cairo)}"

# --- Stage verified source ---
if [ ! -d "$SRC_DIR" ]; then
    echo "==> Staging verified cairo $CAIRO_VERSION source..."
    kandelo_package_stage_verified_source cairo "$SRC_DIR" \
        "${WASM_POSIX_DEP_SOURCE_DIR:-}" "$SOURCE_URL" "$SOURCE_SHA256" \
        "$KANDELO_PACKAGE_WORK_DIR"
fi

# Fresh build dir each run — meson bakes --prefix into the build tree.
rm -rf "$BUILD_DIR"
# The resolver-created output directory is itself publication authority, so
# a recipe must populate that inode rather than delete and recreate it.
if [ -n "${WASM_POSIX_DEP_OUT_DIR:-}" ]; then
    if [ -n "$(find "$INSTALL_DIR" -mindepth 1 -print -quit)" ]; then
        echo "ERROR: cairo resolver output directory must start empty" >&2
        exit 1
    fi
else
    rm -rf "$INSTALL_DIR"
fi

echo "==> Configuring cairo $CAIRO_VERSION for wasm32..."
PKG_CONFIG_PATH="$DEP_PKG_CONFIG_PATH" meson setup "$BUILD_DIR" "$SRC_DIR" \
    --cross-file "$CROSS_FILE" \
    --prefix "$INSTALL_DIR" \
    --libdir lib \
    -Dbuildtype=plain \
    -Doptimization=2 \
    -Dfreetype=enabled \
    -Dfontconfig=enabled \
    -Dpng=enabled \
    -Dzlib=enabled \
    -Dglib=enabled \
    -Dxlib=disabled \
    -Dxcb=disabled \
    -Dxlib-xcb=disabled \
    -Dquartz=disabled \
    -Ddwrite=disabled \
    -Dtee=disabled \
    -Dlzo=disabled \
    -Dspectre=disabled \
    -Dsymbol-lookup=disabled \
    -Dtests=disabled \
    -Dgtk2-utils=disabled \
    -Dgtk_doc=false

echo "==> Building cairo..."
ninja -C "$BUILD_DIR"

echo "==> Installing to $INSTALL_DIR..."
meson install -C "$BUILD_DIR" --no-rebuild

# cairo-trace is a shell wrapper that LD_PRELOADs libcairo-trace.so into
# a dynamically linked program. Upstream enables it for any 'linux' host
# (the cross file's musl/POSIX identity), but Kandelo programs are
# statically linked with no LD_PRELOAD interposition, so the installed
# wrapper and its archive cannot work. Do not ship them.
rm -f "$INSTALL_DIR/bin/cairo-trace"
rm -rf "$INSTALL_DIR/lib/cairo"
rmdir "$INSTALL_DIR/bin" 2>/dev/null || true

if [ -f "$INSTALL_DIR/lib/libcairo.a" ] && [ -f "$INSTALL_DIR/lib/libcairo-gobject.a" ]; then
    echo "==> cairo build complete!"
    ls -lh "$INSTALL_DIR/lib/"libcairo*.a
else
    echo "ERROR: Build failed — libraries not found at $INSTALL_DIR/lib/libcairo{,-gobject}.a" >&2
    exit 1
fi
