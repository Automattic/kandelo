#!/usr/bin/env bash
#
# Build the browser lazy-archive bundle for CPython. Reshapes the cpython
# package's python.wasm + python-runtime.zip into a root-relative
# python.zip (bin/python3 + bin/python + lib/python3.13/…). Consumers see
# the bare zip at programs/wasm32/python.zip.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"
OUT_DIR="${WASM_POSIX_DEP_OUT_DIR:-}"
WORK_DIR="${WASM_POSIX_DEP_WORK_DIR:-}"
CPYTHON_DIR="${WASM_POSIX_DEP_CPYTHON_DIR:-}"
TARGET_ARCH="${WASM_POSIX_DEP_TARGET_ARCH:-}"

fail() { echo "build-python-browser-bundle: $*" >&2; exit 2; }

require_real_directory() {
    local label="$1" path="$2"
    case "$path" in /*) ;; *) fail "$label must be an absolute resolver-owned directory: $path" ;; esac
    if [ ! -d "$path" ] || [ -L "$path" ]; then fail "$label must be a real directory: $path"; fi
}

[ "$TARGET_ARCH" = wasm32 ] || fail "browser bundle supports only wasm32"
require_real_directory WASM_POSIX_DEP_OUT_DIR "$OUT_DIR"
require_real_directory WASM_POSIX_DEP_WORK_DIR "$WORK_DIR"
require_real_directory WASM_POSIX_DEP_CPYTHON_DIR "$CPYTHON_DIR"

archive="$WORK_DIR/python.zip"
bash "$REPO_ROOT/images/vfs/scripts/build-python-zip.sh" "$CPYTHON_DIR" "$archive"

export WASM_POSIX_INSTALL_LOCAL_MIRROR=0
export WASM_POSIX_INSTALL_FORK_INSTRUMENTATION=disabled
# shellcheck source=/dev/null
source "$REPO_ROOT/scripts/install-local-binary.sh"
install_local_binary python-browser-bundle "$archive" python.zip
