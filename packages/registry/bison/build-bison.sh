#!/usr/bin/env bash
# Cross-compile GNU Bison for Kandelo. Outputs bison.wasm and bison-data.zip
# (share/bison, mounted at /usr).
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$HERE/../../.." && pwd)"
source "$REPO_ROOT/scripts/package-build-roots.sh"
kandelo_package_load_source_metadata "$HERE"
kandelo_package_prepare_build_roots "$HERE" wasm32
WORK="$KANDELO_PACKAGE_WORK_DIR"
SRC="$WORK/bison-src"
STAGE="$WORK/bison-stage"
source "$REPO_ROOT/sdk/activate.sh"
export WASM_POSIX_SYSROOT="$REPO_ROOT/sysroot"

rm -rf "$SRC" "$STAGE"
kandelo_package_stage_primary_source bison "$SRC" "$WORK"

# Bison runs m4 at run time, from the path configure records. Name the
# guest's GNU m4 and answer the checks configure would run on it; running
# them would test the build machine's m4 instead.
export ac_cv_path_M4=/usr/bin/m4
export ac_cv_prog_gnu_m4_gnu=yes
export ac_cv_prog_gnu_m4_debugfile=--debugfile

cd "$SRC"
echo "==> Configuring bison..."
wasm32posix-configure \
    --prefix=/usr \
    --disable-nls \
    --disable-yacc \
    2>&1 | tail -15
echo "==> Building bison..."
make -j"$(sysctl -n hw.ncpu 2>/dev/null || nproc)" 2>&1 | tail -15
make install DESTDIR="$STAGE" 2>&1 | tail -5

[ -f "$SRC/src/bison" ] || { echo "ERROR: bison was not built" >&2; exit 1; }
[ -f "$STAGE/usr/share/bison/m4sugar/m4sugar.m4" ] || { echo "ERROR: bison data was not installed" >&2; exit 1; }
cp "$SRC/src/bison" "$WORK/bison.wasm"

DATA="$WORK/bison-data"
rm -rf "$DATA"
mkdir -p "$DATA/share"
cp -R "$STAGE/usr/share/bison" "$DATA/share/bison"
bash "$REPO_ROOT/images/vfs/scripts/create-deterministic-zip.sh" "$DATA" "$WORK/bison-data.zip"

cd "$REPO_ROOT"
if [ -n "${WASM_POSIX_DEP_OUT_DIR:-}" ]; then
    export WASM_POSIX_INSTALL_LOCAL_MIRROR=0
fi
source "$REPO_ROOT/scripts/install-local-binary.sh"
WASM_POSIX_INSTALL_FORK_INSTRUMENTATION=auto \
    install_local_binary bison "$WORK/bison.wasm" bison.wasm
WASM_POSIX_INSTALL_FORK_INSTRUMENTATION=disabled \
    install_local_binary bison "$WORK/bison-data.zip" bison-data.zip
