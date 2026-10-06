#!/usr/bin/env bash
#
# Build libpng (libpng16.a) for wasm32-posix-kernel.
#
# Honors the dep-resolver build-script contract (see
# docs/package-management.md). When invoked via
# `cargo xtask build-deps resolve libpng`, env vars are set by the
# resolver and the build installs into the shared cache:
#
#     WASM_POSIX_DEP_OUT_DIR        # where to `make install`
#     WASM_POSIX_DEP_VERSION        # upstream version
#     WASM_POSIX_DEP_SOURCE_URL     # tarball URL
#     WASM_POSIX_DEP_SOURCE_SHA256  # expected sha256 of the tarball
#     WASM_POSIX_DEP_ZLIB_DIR       # resolved zlib prefix (direct dep)
#
# For ad-hoc / legacy invocation (`bash build-libpng.sh`), the script
# falls back to the in-tree `libpng-install/` layout and the zlib
# artifacts previously staged into `$REPO_ROOT/sysroot`.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"
source "$REPO_ROOT/scripts/package-build-roots.sh"
kandelo_package_load_source_metadata "$SCRIPT_DIR"
source "$REPO_ROOT/sdk/activate.sh"
LIBPNG_VERSION="$WASM_POSIX_DEP_VERSION"
# shellcheck source=/dev/null
# WHY: two resolves of this recipe can run at once in one checkout (two
# test files missing the cache together). Each keeps its source and build
# tree under its own resolver work root so neither deletes the other's.
# A standalone run keeps them beside this script.
kandelo_package_prepare_build_roots "$SCRIPT_DIR" wasm32
SRC_DIR="$KANDELO_PACKAGE_WORK_DIR/libpng-src"

# --- Inputs from resolver, with legacy fallbacks ---

INSTALL_DIR="${WASM_POSIX_DEP_OUT_DIR:-$SCRIPT_DIR/libpng-install}"
SOURCE_URL="$WASM_POSIX_DEP_SOURCE_URL"
SOURCE_SHA256="$WASM_POSIX_DEP_SOURCE_SHA256"

# autoconf bakes --prefix into the Makefile. A rerun from a different
# INSTALL_DIR would install into the wrong path, so always build in a
# fresh dir rather than reusing a stale libpng-build/.
BUILD_DIR="$KANDELO_PACKAGE_WORK_DIR/libpng-build"

if ! command -v wasm32posix-cc &>/dev/null; then
    echo "ERROR: wasm32posix-cc not found. Run 'npm link' in sdk/ first." >&2
    exit 1
fi

# --- Locate zlib ---
# Resolver surfaces the direct-dep install path via contract env var.
# Legacy mode falls back to the sysroot artifact.
SYSROOT="${WASM_POSIX_SYSROOT:-$REPO_ROOT/sysroot}"
ZLIB_PREFIX="${WASM_POSIX_DEP_ZLIB_DIR:-}"
if [ -z "$ZLIB_PREFIX" ]; then
    if [ -f "$SYSROOT/lib/libz.a" ]; then
        ZLIB_PREFIX="$SYSROOT"
    else
        echo "ERROR: zlib not found. Set WASM_POSIX_DEP_ZLIB_DIR or stage libz.a into $SYSROOT/lib/." >&2
        exit 1
    fi
fi

# --- Stage verified source ---
kandelo_package_stage_primary_source libpng "$SRC_DIR" "$KANDELO_PACKAGE_WORK_DIR"

# Fresh build + install dir each run. The cache path varies per key
# and autoconf-generated Makefiles are not portable across prefixes.
rm -rf "$BUILD_DIR"
mkdir -p "$BUILD_DIR"

echo "==> Configuring libpng for wasm32 (zlib at $ZLIB_PREFIX)..."
(
    cd "$BUILD_DIR"
    CFLAGS="-O2" \
    ac_cv_func_feenableexcept=no \
    "$SRC_DIR/configure" \
        --host=wasm32-unknown-none \
        --prefix="$INSTALL_DIR" \
        --enable-static \
        --disable-shared \
        --with-zlib-prefix="$ZLIB_PREFIX" \
        CC=wasm32posix-cc \
        AR=wasm32posix-ar \
        RANLIB=wasm32posix-ranlib \
        CPPFLAGS="-I$ZLIB_PREFIX/include" \
        LDFLAGS="-L$ZLIB_PREFIX/lib"

    echo "==> Building libpng..."
    make -j"$(sysctl -n hw.ncpu 2>/dev/null || nproc)"

    echo "==> Installing to $INSTALL_DIR..."
    make install
)

# Drop the host-side CLI helpers — they're consumer utilities, not
# library outputs, and `make install` also stages them under bin/.
rm -rf "$INSTALL_DIR/bin" "$INSTALL_DIR/share"

if [ -f "$INSTALL_DIR/lib/libpng16.a" ]; then
    echo "==> libpng build complete!"
    ls -lh "$INSTALL_DIR/lib/"libpng*.a
else
    echo "ERROR: Build failed — library not found at $INSTALL_DIR/lib/libpng16.a" >&2
    exit 1
fi
