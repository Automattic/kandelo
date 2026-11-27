#!/usr/bin/env bash
#
# Build the browser lazy-archive bundle for Node.js. Reshapes the node
# package's node.wasm plus native Amaro and unchanged bundled npm into a root-relative
# spidermonkey-node.zip (bin/spidermonkey-node + bin/node symlink + bin/npm + bin/npx + lib/npm/…). Consumers see the
# bare zip at programs/wasm32/spidermonkey-node.zip.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"
OUT_DIR="${WASM_POSIX_DEP_OUT_DIR:-}"
WORK_DIR="${WASM_POSIX_DEP_WORK_DIR:-}"
NODE_DIR="${WASM_POSIX_DEP_NODE_DIR:-}"
AMARO_DIR="${WASM_POSIX_DEP_NODE_AMARO_DIR:-}"
UNDICI_DIR="${WASM_POSIX_DEP_NODE_UNDICI_LLHTTP_DIR:-}"
SOURCE_DIR="${WASM_POSIX_DEP_SOURCE_DIR:-}"
TARGET_ARCH="${WASM_POSIX_DEP_TARGET_ARCH:-}"

fail() { echo "build-node-browser-bundle: $*" >&2; exit 2; }

require_real_directory() {
    local label="$1" path="$2"
    case "$path" in /*) ;; *) fail "$label must be an absolute resolver-owned directory: $path" ;; esac
    if [ ! -d "$path" ] || [ -L "$path" ]; then fail "$label must be a real directory: $path"; fi
}

[ "$TARGET_ARCH" = wasm32 ] || fail "browser bundle supports only wasm32"
require_real_directory WASM_POSIX_DEP_OUT_DIR "$OUT_DIR"
require_real_directory WASM_POSIX_DEP_WORK_DIR "$WORK_DIR"
require_real_directory WASM_POSIX_DEP_NODE_DIR "$NODE_DIR"
require_real_directory WASM_POSIX_DEP_NODE_AMARO_DIR "$AMARO_DIR"
require_real_directory WASM_POSIX_DEP_NODE_UNDICI_LLHTTP_DIR "$UNDICI_DIR"
require_real_directory WASM_POSIX_DEP_SOURCE_DIR "$SOURCE_DIR"

node_wasm="$NODE_DIR/node.wasm"
[ -f "$node_wasm" ] || fail "node.wasm not found under $NODE_DIR"
[ -f "$SOURCE_DIR/deps/npm/bin/npm-cli.js" ] || fail "bundled npm not found in pinned Node archive"
[ -f "$AMARO_DIR/lib/libnode-amaro.so" ] || fail "native Amaro dependency is missing"
[ -f "$UNDICI_DIR/lib/libnode-undici-llhttp.so" ] || fail "native Undici parser dependency is missing"

# Run the memfs->zip staging through the repo-locked tsx (never `npx`, which
# would download a fresh tsx and fail offline). Point TMPDIR at a short /tmp
# scratch dir so tsx's IPC socket path stays under the macOS unix-socket limit.
DECLARED_TOOL_PATH="${KANDELO_DEV_SHELL_TOOL_PATH:-$PATH}"
NODE_BIN="$(PATH="$DECLARED_TOOL_PATH" type -P node || true)"
[ -n "$NODE_BIN" ] || fail "node is not available from KANDELO_DEV_SHELL_TOOL_PATH"
TSX_CLI="$REPO_ROOT/node_modules/tsx/dist/cli.mjs"
[ -f "$TSX_CLI" ] || fail "locked tsx CLI not found at $TSX_CLI"
TSX_TMP="$(mktemp -d /tmp/kandelo-node.XXXXXX)"
trap 'rm -rf -- "$TSX_TMP"' EXIT

archive="$WORK_DIR/spidermonkey-node.zip"
TMPDIR="$TSX_TMP" PATH="$DECLARED_TOOL_PATH" \
    "$NODE_BIN" "$TSX_CLI" \
    "$REPO_ROOT/images/vfs/scripts/build-node-zip.ts" \
    "$node_wasm" "$SOURCE_DIR/deps/npm" "$AMARO_DIR/lib/libnode-amaro.so" "$UNDICI_DIR/lib/libnode-undici-llhttp.so" "$archive"

export WASM_POSIX_INSTALL_LOCAL_MIRROR=0
export WASM_POSIX_INSTALL_FORK_INSTRUMENTATION=disabled
# shellcheck source=/dev/null
source "$REPO_ROOT/scripts/install-local-binary.sh"
install_local_binary node-browser-bundle "$archive" spidermonkey-node.zip
