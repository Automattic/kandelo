#!/usr/bin/env bash
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"
cd "$REPO_ROOT"

if [ "$#" -ne 0 ] && [ "${1:-}" = "--vfs-product-manifest" ]; then
  exec node "$REPO_ROOT/node_modules/tsx/dist/cli.mjs" \
    "$SCRIPT_DIR/staged-product-inputs.ts" browser-nginx-python "$@"
fi

echo "==> Building nginx + Python VFS image..."

WORK_DIR="${WASM_POSIX_DEP_WORK_DIR:-$(mktemp -d /tmp/kandelo-nginx-python.XXXXXX)}"
VFS_DIR="$REPO_ROOT/apps/browser-demos/public"
if [ -n "${WASM_POSIX_DEP_OUT_DIR:-}" ]; then
  : "${WASM_POSIX_DEP_WORK_DIR:?resolver VFS builds require WASM_POSIX_DEP_WORK_DIR}"
  VFS_DIR="$WASM_POSIX_DEP_WORK_DIR"
fi
VFS="$VFS_DIR/nginx-python-vfs.vfs.zst"

# Resolve CPython (interpreter + runtime zip).
CPYTHON_DIR="${WASM_POSIX_DEP_CPYTHON_DIR:-}"
if [ -z "$CPYTHON_DIR" ]; then
  HOST_TARGET="$(rustc -vV | awk '/^host/ {print $2}')"
  CPYTHON_DIR="$(cargo run -p xtask --target "$HOST_TARGET" --quiet -- build-deps resolve cpython)"
fi
PYTHON_WASM="$CPYTHON_DIR/python.wasm"
PYTHON_RUNTIME="$CPYTHON_DIR/python-runtime.zip"
[ -f "$PYTHON_WASM" ] && [ -f "$PYTHON_RUNTIME" ] || {
  echo "ERROR: cpython must provide python.wasm and python-runtime.zip: $CPYTHON_DIR" >&2
  exit 1
}
RUNTIME_ROOT="$WORK_DIR/python-runtime"
rm -rf "$RUNTIME_ROOT"; mkdir -p "$RUNTIME_ROOT"
unzip -q "$PYTHON_RUNTIME" -d "$RUNTIME_ROOT"

KANDELO_PYTHON_RUNTIME_ROOT="$RUNTIME_ROOT" \
KANDELO_PYTHON_WASM="$PYTHON_WASM" \
  npx tsx "$SCRIPT_DIR/build-nginx-python-vfs-image.ts" "$VFS"

[ -f "$VFS" ] || { echo "ERROR: $VFS not produced" >&2; exit 1; }
echo "==> Done."; ls -lh "$VFS"

if [ -n "${WASM_POSIX_DEP_OUT_DIR:-}" ]; then
  export WASM_POSIX_INSTALL_LOCAL_MIRROR=0
  export WASM_POSIX_INSTALL_FORK_INSTRUMENTATION=disabled
fi
source "$REPO_ROOT/scripts/install-local-binary.sh"
install_local_binary nginx-python-vfs "$VFS"
