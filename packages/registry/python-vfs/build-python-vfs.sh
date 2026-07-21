#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"
WORK_DIR="${WASM_POSIX_DEP_WORK_DIR:-$SCRIPT_DIR}"
OUT_DIR="${WASM_POSIX_DEP_OUT_DIR:-$SCRIPT_DIR}"
CPYTHON_DIR="${WASM_POSIX_DEP_CPYTHON_DIR:-}"

mkdir -p "$WORK_DIR" "$OUT_DIR"

if [ -z "$CPYTHON_DIR" ]; then
    HOST_TARGET="$(rustc -vV | awk '/^host/ {print $2}')"
    echo "==> Resolving CPython through the package resolver..."
    CPYTHON_DIR="$(
        cd "$REPO_ROOT"
        cargo run -p xtask --target "$HOST_TARGET" --quiet -- build-deps resolve cpython
    )"
fi

PYTHON_WASM="$CPYTHON_DIR/python.wasm"
PYTHON_RUNTIME="$CPYTHON_DIR/python-runtime.zip"
if [ ! -f "$PYTHON_WASM" ] || [ ! -f "$PYTHON_RUNTIME" ]; then
    echo "ERROR: CPython dependency must provide python.wasm and python-runtime.zip: $CPYTHON_DIR" >&2
    exit 1
fi

RUNTIME_ROOT="$WORK_DIR/python-runtime"
rm -rf "$RUNTIME_ROOT"
mkdir -p "$RUNTIME_ROOT"
unzip -q "$PYTHON_RUNTIME" -d "$RUNTIME_ROOT"

VFS="$WORK_DIR/python-vfs.vfs.zst"
KANDELO_PYTHON_RUNTIME_ROOT="$RUNTIME_ROOT" \
KANDELO_PYTHON_WASM="$PYTHON_WASM" \
KANDELO_PYTHON_VFS_OUT="$VFS" \
    npx tsx "$REPO_ROOT/images/vfs/scripts/build-python-vfs-image.ts"

[ -f "$VFS" ] || { echo "ERROR: $VFS not produced" >&2; exit 1; }

if [ -n "${WASM_POSIX_DEP_OUT_DIR:-}" ]; then
    export WASM_POSIX_INSTALL_LOCAL_MIRROR=0
fi
# shellcheck source=/dev/null
source "$REPO_ROOT/scripts/install-local-binary.sh"
install_local_binary python-vfs "$VFS"
