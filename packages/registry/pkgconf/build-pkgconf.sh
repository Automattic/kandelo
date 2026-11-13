#!/usr/bin/env bash
# Cross-compile pkgconf for Kandelo. Outputs pkgconf.wasm and
# pkgconf-data.zip (share/aclocal/pkg.m4, mounted at /usr).
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$HERE/../../.." && pwd)"
source "$REPO_ROOT/scripts/package-build-roots.sh"
kandelo_package_load_source_metadata "$HERE"
kandelo_package_prepare_build_roots "$HERE" wasm32
WORK="$KANDELO_PACKAGE_WORK_DIR"
SRC="$WORK/pkgconf-src"
STAGE="$WORK/pkgconf-stage"
source "$REPO_ROOT/sdk/activate.sh"
export WASM_POSIX_SYSROOT="$REPO_ROOT/sysroot"

rm -rf "$SRC" "$STAGE"
kandelo_package_stage_primary_source pkgconf "$SRC" "$WORK"

# The guest SDK's sysroot, which the guest's cc compiles and links against.
GUEST_SYSROOT=/usr/lib/kandelo/wasm32posix/sysroot
PC_PATH=/usr/local/lib/pkgconfig:/usr/local/share/pkgconfig
PC_PATH=$PC_PATH:/usr/lib/pkgconfig:/usr/share/pkgconfig
PC_PATH=$PC_PATH:$GUEST_SYSROOT/lib/pkgconfig:$GUEST_SYSROOT/share/pkgconfig

cd "$SRC"
echo "==> Configuring pkgconf..."
wasm32posix-configure \
    --prefix=/usr \
    --disable-shared \
    --enable-static \
    --with-pkg-config-dir="$PC_PATH" \
    --with-system-libdir="$GUEST_SYSROOT/lib" \
    --with-system-includedir="$GUEST_SYSROOT/include" \
    2>&1 | tail -15
echo "==> Building pkgconf..."
make -j"$(sysctl -n hw.ncpu 2>/dev/null || nproc)" 2>&1 | tail -15
make install DESTDIR="$STAGE" 2>&1 | tail -5

[ -f "$STAGE/usr/bin/pkgconf" ] || { echo "ERROR: pkgconf was not built" >&2; exit 1; }
[ -f "$STAGE/usr/share/aclocal/pkg.m4" ] || { echo "ERROR: pkg.m4 was not installed" >&2; exit 1; }
cp "$STAGE/usr/bin/pkgconf" "$WORK/pkgconf.wasm"

DATA="$WORK/pkgconf-data"
rm -rf "$DATA"
mkdir -p "$DATA/share/aclocal"
cp "$STAGE/usr/share/aclocal/pkg.m4" "$DATA/share/aclocal/pkg.m4"
bash "$REPO_ROOT/images/vfs/scripts/create-deterministic-zip.sh" "$DATA" "$WORK/pkgconf-data.zip"

cd "$REPO_ROOT"
if [ -n "${WASM_POSIX_DEP_OUT_DIR:-}" ]; then
    export WASM_POSIX_INSTALL_LOCAL_MIRROR=0
fi
source "$REPO_ROOT/scripts/install-local-binary.sh"
WASM_POSIX_INSTALL_FORK_INSTRUMENTATION=auto \
    install_local_binary pkgconf "$WORK/pkgconf.wasm" pkgconf.wasm
WASM_POSIX_INSTALL_FORK_INSTRUMENTATION=disabled \
    install_local_binary pkgconf "$WORK/pkgconf-data.zip" pkgconf-data.zip
