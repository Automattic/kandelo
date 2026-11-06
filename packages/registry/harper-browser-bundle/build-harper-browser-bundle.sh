#!/usr/bin/env bash
# One lazy ZIP for both already-instrumented Harper executables.
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"

fail() {
    echo "build-harper-browser-bundle: $*" >&2
    exit 2
}

require_real_directory() {
    local label="$1" path="$2"
    case "$path" in
        /*) ;;
        *) fail "$label must be an absolute resolver-owned directory: $path" ;;
    esac
    [ -d "$path" ] && [ ! -L "$path" ] || fail "$label must be a real directory: $path"
}

[ "${WASM_POSIX_DEP_TARGET_ARCH:-}" = wasm32 ] || fail "bundle supports only wasm32"
require_real_directory WASM_POSIX_DEP_OUT_DIR "${WASM_POSIX_DEP_OUT_DIR:-}"
require_real_directory WASM_POSIX_DEP_WORK_DIR "${WASM_POSIX_DEP_WORK_DIR:-}"
require_real_directory WASM_POSIX_DEP_HARPER_DIR "${WASM_POSIX_DEP_HARPER_DIR:-}"

staging="$(mktemp -d "$WASM_POSIX_DEP_WORK_DIR/harper-zip.XXXXXX")"
trap 'rm -rf "$staging"' EXIT
mkdir -p "$staging/bin"
for program in harper-cli harper-ls; do
    source_path="$WASM_POSIX_DEP_HARPER_DIR/$program.wasm"
    [ -f "$source_path" ] && [ ! -L "$source_path" ] || fail "missing regular dependency output: $source_path"
    cp "$source_path" "$staging/bin/$program"
    chmod 0755 "$staging/bin/$program"
done
archive="$WASM_POSIX_DEP_WORK_DIR/harper.zip"
bash "$REPO_ROOT/images/vfs/scripts/create-deterministic-zip.sh" "$staging" "$archive"

export WASM_POSIX_INSTALL_LOCAL_MIRROR=0
export WASM_POSIX_INSTALL_FORK_INSTRUMENTATION=disabled
source "$REPO_ROOT/scripts/install-local-binary.sh"
install_local_binary harper-browser-bundle "$archive" harper.zip
