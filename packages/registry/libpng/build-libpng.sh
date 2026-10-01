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
# artifacts previously staged into `$REPO_ROOT/sysroot`, and builds next
# to this script instead of in the resolver work dir.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"
# shellcheck source=/dev/null
source "$REPO_ROOT/scripts/package-build-roots.sh"
# Build under the package work root: the resolver's fresh
# WASM_POSIX_DEP_WORK_DIR, or this directory for a direct invocation. The
# resolver reruns this script only when the package's cache key changed (an
# ABI bump, a toolchain change). A source tree kept in the package directory
# survived across those rebuilds, so a stale extraction could be reused.
kandelo_package_prepare_build_roots "$SCRIPT_DIR" wasm32
WORK_DIR="$KANDELO_PACKAGE_WORK_DIR"
SRC_DIR="$WORK_DIR/libpng-src"

# --- Inputs from resolver, with legacy fallbacks ---
LIBPNG_VERSION="${WASM_POSIX_DEP_VERSION:-${LIBPNG_VERSION:-1.6.43}}"
INSTALL_DIR="${WASM_POSIX_DEP_OUT_DIR:-$SCRIPT_DIR/libpng-install}"
SOURCE_URL="${WASM_POSIX_DEP_SOURCE_URL:-https://download.sourceforge.net/libpng/libpng-${LIBPNG_VERSION}.tar.xz}"
SOURCE_SHA256="${WASM_POSIX_DEP_SOURCE_SHA256:-6a5ca0652392a2d7c9db2ae5b40210843c0bbc081cbd410825ab00cc59f14a6c}"

# autoconf bakes --prefix into the Makefile. A rerun from a different
# INSTALL_DIR would install into the wrong path, so always build in a
# fresh dir rather than reusing a stale libpng-build/.
BUILD_DIR="$WORK_DIR/libpng-build"

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

# --- Stage the pinned source ---
# Under the resolver the verified, unpacked source arrives in
# WASM_POSIX_DEP_SOURCE_DIR (from the resolver's source-archive cache, so a
# rebuild does not depend on the upstream mirror being up); a direct run
# downloads the archive and checks its sha256.
if [ ! -d "$SRC_DIR" ]; then
    echo "==> Staging pinned libpng $LIBPNG_VERSION source..."
    kandelo_package_stage_verified_source libpng "$SRC_DIR" \
        "${WASM_POSIX_DEP_SOURCE_DIR:-}" "$SOURCE_URL" "$SOURCE_SHA256" "$WORK_DIR"
fi

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
