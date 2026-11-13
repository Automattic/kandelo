#!/usr/bin/env bash
# Build GNU Texinfo for Kandelo: texinfo.zip (the Perl and shell programs
# and their data, mounted at /usr) and install-info.wasm (cross-compiled C).
# Scripts record the build machine's perl and shell, which
# scripts/rewrite-guest-tool-paths.py points at the guest's.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$HERE/../../.." && pwd)"
source "$REPO_ROOT/scripts/package-build-roots.sh"
kandelo_package_load_source_metadata "$HERE"
kandelo_package_prepare_build_roots "$HERE" wasm32
WORK="$KANDELO_PACKAGE_WORK_DIR"
SRC="$WORK/texinfo-src"
STAGE="$WORK/texinfo-stage"
source "$REPO_ROOT/sdk/activate.sh"
export WASM_POSIX_SYSROOT="$REPO_ROOT/sysroot"

rm -rf "$SRC" "$STAGE"
kandelo_package_stage_primary_source texinfo "$SRC" "$WORK"
for patch in "$HERE"/patches/*.patch; do
    patch -p1 -d "$SRC" < "$patch"
done
cd "$SRC"
echo "==> Configuring texinfo..."
wasm32posix-configure --prefix=/usr --disable-perl-xs --disable-nls 2>&1 | tail -15
echo "==> Building texinfo..."
make -j"$(sysctl -n hw.ncpu 2>/dev/null || nproc)" 2>&1 | tail -10
make install DESTDIR="$STAGE" 2>&1 | tail -5

TREE="$STAGE/usr"
[ -f "$TREE/bin/texi2any" ] || { echo "ERROR: texi2any was not installed" >&2; exit 1; }
[ -f "$TREE/bin/install-info" ] || { echo "ERROR: install-info was not built" >&2; exit 1; }
mv "$TREE/bin/install-info" "$WORK/install-info.wasm"
rm -rf "$TREE/share/man" "$TREE/share/info" "$TREE/share/locale"
python3 "$REPO_ROOT/scripts/rewrite-guest-tool-paths.py" "$TREE" \
    --map "$WASM_POSIX_SYSROOT=/usr/lib/kandelo/wasm32posix/sysroot" \
    "$WORK" "$REPO_ROOT" "$SRC"
bash "$REPO_ROOT/images/vfs/scripts/create-deterministic-zip.sh" "$TREE" "$WORK/texinfo.zip"

cd "$REPO_ROOT"
if [ -n "${WASM_POSIX_DEP_OUT_DIR:-}" ]; then
    export WASM_POSIX_INSTALL_LOCAL_MIRROR=0
fi
source "$REPO_ROOT/scripts/install-local-binary.sh"
WASM_POSIX_INSTALL_FORK_INSTRUMENTATION=disabled \
    install_local_binary texinfo "$WORK/texinfo.zip" texinfo.zip
WASM_POSIX_INSTALL_FORK_INSTRUMENTATION=auto \
    install_local_binary texinfo "$WORK/install-info.wasm" install-info.wasm
