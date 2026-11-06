#!/usr/bin/env bash
# Cross-compile Berkeley yacc for Kandelo: the rootfs's POSIX `yacc`.
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$HERE/../../.." && pwd)"
source "$REPO_ROOT/scripts/package-build-roots.sh"
kandelo_package_load_source_metadata "$HERE"
# shellcheck source=/dev/null
kandelo_package_prepare_build_roots "$HERE" wasm32
WORK_DIR="$KANDELO_PACKAGE_WORK_DIR"
SRC="$WORK_DIR/byacc-src"
OUT_BIN="$WORK_DIR/yacc.wasm"

if [ -z "${WASM_POSIX_DEP_WORK_DIR:-}" ] || [ -z "${WASM_POSIX_DEP_OUT_DIR:-}" ]; then
    echo "ERROR: build byacc with ./run.sh build byacc" >&2
    exit 2
fi
export WASM_POSIX_INSTALL_LOCAL_MIRROR=0
export WASM_POSIX_INSTALL_FORK_INSTRUMENTATION=auto

source "$REPO_ROOT/sdk/activate.sh"
export WASM_POSIX_SYSROOT="$REPO_ROOT/sysroot"

rm -rf "$SRC"
echo "==> Staging verified byacc $WASM_POSIX_DEP_VERSION source..."
kandelo_package_stage_verified_source byacc "$SRC" "${WASM_POSIX_DEP_SOURCE_DIR:-}" \
    "$WASM_POSIX_DEP_SOURCE_URL" "$WASM_POSIX_DEP_SOURCE_SHA256" "$WORK_DIR"
cd "$SRC"

echo "==> Configuring byacc..."
wasm32posix-configure 2>&1 | tail -20
echo "==> Building yacc..."
make yacc 2>&1 | tail -20
[ -f yacc ] || { echo "ERROR: yacc was not built" >&2; exit 1; }
cp yacc "$OUT_BIN"

cd "$REPO_ROOT"
source "$REPO_ROOT/scripts/install-local-binary.sh"
install_local_binary byacc "$OUT_BIN" yacc.wasm
