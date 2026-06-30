#!/usr/bin/env bash
# Stage the SpiderMonkey shell's Node-compatible entry point as an explicit
# Kandelo program package.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"
# shellcheck source=/dev/null
source "$REPO_ROOT/sdk/activate.sh"

ARCH="${WASM_POSIX_DEP_TARGET_ARCH:-wasm32}"
if [ "$ARCH" != "wasm32" ]; then
    echo "ERROR: spidermonkey-node currently supports wasm32 only, got '$ARCH'." >&2
    exit 1
fi

SPIDERMONKEY_PREFIX="${WASM_POSIX_DEP_SPIDERMONKEY_DIR:-}"
NODE_WASM=""

for candidate in \
    "${SPIDERMONKEY_PREFIX:+$SPIDERMONKEY_PREFIX/node.wasm}" \
    "$REPO_ROOT/packages/registry/spidermonkey/bin/node.wasm" \
    "$REPO_ROOT/local-binaries/programs/$ARCH/spidermonkey-node.wasm"; do
    if [ -z "$NODE_WASM" ] && [ -f "$candidate" ]; then
        NODE_WASM="$candidate"
    fi
done

if [ -z "$NODE_WASM" ]; then
    if ! command -v rustc >/dev/null 2>&1 || ! command -v cargo >/dev/null 2>&1; then
        echo "ERROR: node.wasm not found in the SpiderMonkey package build or local binaries, and rustc/cargo are unavailable for dependency resolution." >&2
        exit 1
    fi

    HOST_TARGET="$(rustc -vV | awk '/^host/ {print $2}')"
    resolve_dep() {
        local name="$1"
        (cd "$REPO_ROOT" && cargo run -p xtask --target "$HOST_TARGET" --quiet -- build-deps resolve "$name")
    }

    echo "==> Resolving spidermonkey via cargo xtask build-deps..."
    SPIDERMONKEY_PREFIX="$(resolve_dep spidermonkey)"
    if [ -f "$SPIDERMONKEY_PREFIX/node.wasm" ]; then
        NODE_WASM="$SPIDERMONKEY_PREFIX/node.wasm"
    else
        echo "ERROR: spidermonkey dependency did not provide node.wasm at $SPIDERMONKEY_PREFIX." >&2
        echo "       Rebuild the spidermonkey package so its Node-compatible shell output is staged." >&2
        exit 1
    fi
fi

WORK_DIR="${WASM_POSIX_DEP_WORK_DIR:-$SCRIPT_DIR}"
if [ -n "${WASM_POSIX_DEP_OUT_DIR:-}" ]; then
    BIN_DIR="$WORK_DIR/bin"
else
    BIN_DIR="$SCRIPT_DIR/bin"
fi
mkdir -p "$BIN_DIR"
cp "$NODE_WASM" "$BIN_DIR/node.wasm"

NODE_SIZE="$(wc -c < "$BIN_DIR/node.wasm" | tr -d ' ')"
echo "==> SpiderMonkey Node-compatible runtime staged: $BIN_DIR/node.wasm ($NODE_SIZE bytes)"

if [ -n "${WASM_POSIX_DEP_OUT_DIR:-}" ]; then
    source "$REPO_ROOT/scripts/wasm-artifact-guards.sh"
    wasm_require_no_legacy_asyncify "$BIN_DIR/node.wasm"
    wasm_require_no_fork_instrumentation "$BIN_DIR/node.wasm"
    rm -rf "$WASM_POSIX_DEP_OUT_DIR"
    mkdir -p "$WASM_POSIX_DEP_OUT_DIR"
    cp "$BIN_DIR/node.wasm" "$WASM_POSIX_DEP_OUT_DIR/node.wasm"
    echo "  installed $WASM_POSIX_DEP_OUT_DIR/node.wasm (resolver scratch)"
elif command -v rustc >/dev/null 2>&1 && command -v cargo >/dev/null 2>&1; then
    # shellcheck source=/dev/null
    source "$REPO_ROOT/scripts/install-local-binary.sh"
    WASM_POSIX_INSTALL_FORK_INSTRUMENTATION=disabled install_local_binary spidermonkey-node "$BIN_DIR/node.wasm"
    WASM_POSIX_INSTALL_FORK_INSTRUMENTATION=disabled install_local_binary node "$BIN_DIR/node.wasm"
else
    for name in spidermonkey-node node; do
        dest="$REPO_ROOT/local-binaries/programs/$ARCH/$name.wasm"
        mkdir -p "$(dirname "$dest")"
        cp "$BIN_DIR/node.wasm" "$dest"
        echo "  installed $dest"
    done
fi
