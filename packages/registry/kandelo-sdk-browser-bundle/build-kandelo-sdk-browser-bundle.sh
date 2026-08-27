#!/usr/bin/env bash
#
# Build the browser lazy-archive bundle for the Kandelo C/C++ toolchain.
#
# The package-system archive remains a .tar.zst, but its declared output is
# kandelo-sdk.zip. Resolver consumers see the bare zip at
# programs/wasm32/kandelo-sdk.zip. The zip bundles cc/c++ (clang + wasm-ld +
# llvm-ar/ranlib/nm), the Clang resource headers, and the SDK sysroot
# (musl libc + libc++), so a browser shell can compile and link C/C++
# programs after one lazy-archive fetch.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"

OUT_DIR="${WASM_POSIX_DEP_OUT_DIR:-}"
WORK_DIR="${WASM_POSIX_DEP_WORK_DIR:-}"
CLANG_DIR="${WASM_POSIX_DEP_CLANG_DIR:-}"
LIBCXX_DIR="${WASM_POSIX_DEP_LIBCXX_DIR:-}"

fail() {
    echo "build-kandelo-sdk-browser-bundle: $*" >&2
    exit 2
}

require_real_directory() {
    local label="$1"
    local path="$2"
    case "$path" in
        /*) ;;
        *) fail "$label must be an absolute resolver-owned directory: $path" ;;
    esac
    if [ ! -d "$path" ] || [ -L "$path" ]; then
        fail "$label must be a real directory: $path"
    fi
}

require_real_directory WASM_POSIX_DEP_OUT_DIR "$OUT_DIR"
require_real_directory WASM_POSIX_DEP_WORK_DIR "$WORK_DIR"
require_real_directory WASM_POSIX_DEP_CLANG_DIR "$CLANG_DIR"
require_real_directory WASM_POSIX_DEP_LIBCXX_DIR "$LIBCXX_DIR"

# shellcheck source=/dev/null
source "$REPO_ROOT/sdk/activate.sh"

archive="$WORK_DIR/kandelo-sdk.zip"
bash "$REPO_ROOT/images/vfs/scripts/build-kandelo-sdk-zip.sh" \
    "$CLANG_DIR" "$LIBCXX_DIR" "$archive"

export WASM_POSIX_INSTALL_LOCAL_MIRROR=0
export WASM_POSIX_INSTALL_FORK_INSTRUMENTATION=disabled
# shellcheck source=/dev/null
source "$REPO_ROOT/scripts/install-local-binary.sh"
install_local_binary kandelo-sdk-browser-bundle "$archive" kandelo-sdk.zip
