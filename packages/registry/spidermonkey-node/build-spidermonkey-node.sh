#!/usr/bin/env bash
# Stage the SpiderMonkey shell's Node-compatible entry point as an explicit
# Kandelo program package.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"
# shellcheck source=/dev/null
source "$REPO_ROOT/sdk/activate.sh"

ARCH="${WASM_POSIX_DEP_TARGET_ARCH:-wasm32}"
PACKAGE_NAME="${WASM_POSIX_DEP_NAME:-spidermonkey-node}"
case "$PACKAGE_NAME" in
    node|spidermonkey-node) ;;
    *) echo "ERROR: unexpected Node-compatible package '$PACKAGE_NAME'." >&2; exit 1 ;;
esac
if [ "$ARCH" != "wasm32" ]; then
    echo "ERROR: spidermonkey-node currently supports wasm32 only, got '$ARCH'." >&2
    exit 1
fi

SPIDERMONKEY_PREFIX="${WASM_POSIX_DEP_SPIDERMONKEY_DIR:-}"
if [ -z "$SPIDERMONKEY_PREFIX" ]; then
    if [ -n "${WASM_POSIX_DEP_OUT_DIR:-}" ]; then
        echo "ERROR: resolver did not provide the declared spidermonkey dependency." >&2
        exit 1
    fi
    if ! command -v rustc >/dev/null 2>&1 || ! command -v cargo >/dev/null 2>&1; then
        echo "ERROR: rustc/cargo are unavailable for SpiderMonkey dependency resolution." >&2
        exit 1
    fi

    HOST_TARGET="$(rustc -vV | awk '/^host/ {print $2}')"
    resolve_dep() {
        local name="$1"
        (cd "$REPO_ROOT" && cargo run -p xtask --target "$HOST_TARGET" --quiet -- build-deps resolve "$name")
    }

    echo "==> Resolving spidermonkey via cargo xtask build-deps..."
    SPIDERMONKEY_PREFIX="$(resolve_dep spidermonkey)"
fi
NODE_WASM="$SPIDERMONKEY_PREFIX/js.wasm"
if [ ! -f "$NODE_WASM" ] || [ -L "$NODE_WASM" ]; then
    echo "ERROR: spidermonkey dependency did not provide its declared js.wasm at $SPIDERMONKEY_PREFIX." >&2
    exit 1
fi

if [ -n "${WASM_POSIX_DEP_WORK_DIR:-}" ] && [ -n "${WASM_POSIX_DEP_OUT_DIR:-}" ]; then
    BIN_DIR="$WASM_POSIX_DEP_WORK_DIR/bin"
else
    BIN_DIR="$SCRIPT_DIR/bin"
fi
mkdir -p "$BIN_DIR"
cp "$NODE_WASM" "$BIN_DIR/node.wasm"

NODE_SIZE="$(wc -c < "$BIN_DIR/node.wasm" | tr -d ' ')"
echo "==> SpiderMonkey Node-compatible runtime staged: $BIN_DIR/node.wasm ($NODE_SIZE bytes)"

# shellcheck source=/dev/null
source "$REPO_ROOT/scripts/install-local-binary.sh"
if [ -n "${WASM_POSIX_DEP_OUT_DIR:-}" ]; then
    export WASM_POSIX_INSTALL_LOCAL_MIRROR=0
fi
WASM_POSIX_INSTALL_FORK_INSTRUMENTATION=auto install_local_binary "$PACKAGE_NAME" "$BIN_DIR/node.wasm" node.wasm
