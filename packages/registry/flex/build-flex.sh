#!/usr/bin/env bash
# Cross-compile flex for Kandelo: the rootfs's POSIX `lex`.
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$HERE/../../.." && pwd)"
source "$REPO_ROOT/scripts/package-build-roots.sh"
kandelo_package_load_source_metadata "$HERE"
# shellcheck source=/dev/null
kandelo_package_prepare_build_roots "$HERE" wasm32
WORK_DIR="$KANDELO_PACKAGE_WORK_DIR"
SRC="$WORK_DIR/flex-src"
OUT_BIN="$WORK_DIR/flex.wasm"

if [ -z "${WASM_POSIX_DEP_WORK_DIR:-}" ] || [ -z "${WASM_POSIX_DEP_OUT_DIR:-}" ]; then
    echo "ERROR: build flex with ./run.sh build flex" >&2
    exit 2
fi
export WASM_POSIX_INSTALL_LOCAL_MIRROR=0
export WASM_POSIX_INSTALL_FORK_INSTRUMENTATION=auto

source "$REPO_ROOT/sdk/activate.sh"
export WASM_POSIX_SYSROOT="$REPO_ROOT/sysroot"

rm -rf "$SRC"
echo "==> Staging verified flex $WASM_POSIX_DEP_VERSION source..."
kandelo_package_stage_verified_source flex "$SRC" "${WASM_POSIX_DEP_SOURCE_DIR:-}" \
    "$WASM_POSIX_DEP_SOURCE_URL" "$WASM_POSIX_DEP_SOURCE_SHA256" "$WORK_DIR"
cd "$SRC"

# flex runs m4 over its scanner skeleton every time it generates a scanner,
# by the path configure records; inside Kandelo that is the rootfs's m4.
# --disable-bootstrap compiles the scanner flex ships (src/scan.c) instead of
# building a first-stage flex to regenerate it, which a cross build cannot
# run. libfl (main and yywrap for -lfl) is left out: guest programs link
# against the SDK sysroot, which has no package libraries.
echo "==> Configuring flex..."
ac_cv_path_M4=/usr/bin/m4 wasm32posix-configure \
    --disable-bootstrap \
    --disable-libfl \
    --disable-nls \
    --disable-shared \
    2>&1 | tail -20
echo "==> Building flex..."
make -C src flex 2>&1 | tail -20
[ -f src/flex ] || { echo "ERROR: flex was not built" >&2; exit 1; }
cp src/flex "$OUT_BIN"

cd "$REPO_ROOT"
source "$REPO_ROOT/scripts/install-local-binary.sh"
install_local_binary flex "$OUT_BIN" flex.wasm
