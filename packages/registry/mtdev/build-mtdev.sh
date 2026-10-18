#!/usr/bin/env bash
#
# Build mtdev (libmtdev.a) for wasm32-posix-kernel through upstream's
# autotools build and the SDK's wasm32posix-configure wrapper, which
# auto-loads sdk/config.site. configure.ac probes no library functions,
# so no cache variable needs a seed.
#
# Only the library, its headers and mtdev.pc are built and installed:
# the test/ programs are upstream's own diagnostics, not package outputs.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"
source "$REPO_ROOT/scripts/package-build-roots.sh"
kandelo_package_load_source_metadata "$SCRIPT_DIR"
# shellcheck source=/dev/null
kandelo_package_prepare_build_roots "$SCRIPT_DIR" wasm32
WORK_DIR="$KANDELO_PACKAGE_WORK_DIR"
SRC_DIR="$WORK_DIR/mtdev-src"
INSTALL_DIR="${KANDELO_PACKAGE_OUT_DIR:-$WORK_DIR/mtdev-install}"

MTDEV_VERSION="$WASM_POSIX_DEP_VERSION"
SOURCE_URL="$WASM_POSIX_DEP_SOURCE_URL"
SOURCE_SHA256="$WASM_POSIX_DEP_SOURCE_SHA256"

# shellcheck source=/dev/null
source "$REPO_ROOT/sdk/activate.sh"
if ! command -v wasm32posix-configure &>/dev/null; then
    echo "ERROR: wasm32posix-configure not found after sourcing sdk/activate.sh." >&2
    exit 1
fi

if [ ! -d "$SRC_DIR" ]; then
    echo "==> Staging verified mtdev $MTDEV_VERSION source..."
    kandelo_package_stage_verified_source mtdev "$SRC_DIR" \
        "${WASM_POSIX_DEP_SOURCE_DIR:-}" "$SOURCE_URL" "$SOURCE_SHA256" "$WORK_DIR"
fi

cd "$SRC_DIR"

if [ ! -f Makefile ]; then
    echo "==> Configuring mtdev for wasm32..."
    wasm32posix-configure \
        --prefix="$INSTALL_DIR" \
        --disable-shared \
        --enable-static \
        2>&1 | tail -30
fi

echo "==> Building mtdev..."
make -C src -j"$(sysctl -n hw.ncpu 2>/dev/null || nproc)" 2>&1 | tail -30

echo "==> Installing mtdev to $INSTALL_DIR..."
make -C src install 2>&1 | tail -15
make install-pkgconfigDATA 2>&1 | tail -5
# libtool's archive description is for libtool-driven links; consumers
# link libmtdev.a through mtdev.pc.
rm -f "$INSTALL_DIR/lib/libmtdev.la"

for f in \
    lib/libmtdev.a \
    lib/pkgconfig/mtdev.pc \
    include/mtdev.h \
    include/mtdev-plumbing.h \
    include/mtdev-mapping.h
do
    if [ ! -f "$INSTALL_DIR/$f" ]; then
        echo "ERROR: expected mtdev output missing: $f" >&2
        exit 1
    fi
done

echo "==> mtdev $MTDEV_VERSION build complete!"
ls -lh "$INSTALL_DIR/lib/libmtdev.a"
