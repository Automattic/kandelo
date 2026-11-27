#!/usr/bin/env bash
# One package owns the engine adapter and the complete standard Node executable.
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"
source "$REPO_ROOT/scripts/package-build-roots.sh"
kandelo_package_prepare_build_roots "$SCRIPT_DIR" wasm32
: "${WASM_POSIX_DEP_WORK_DIR:?build through the normal resolver}"
: "${WASM_POSIX_DEP_OUT_DIR:?build through the normal resolver}"
if [ "${WASM_POSIX_DEP_NAME:?}" != spidermonkey-node ] || \
   [ "${WASM_POSIX_DEP_TARGET_ARCH:-wasm32}" != wasm32 ]; then
    echo 'ERROR: unexpected Node package/architecture' >&2; exit 2
fi
if [ "$#" -gt 0 ]; then
    # The unshipped native companion replaces main without changing Node flags.
    [ "$#" = 1 ] && [ "$1" = --native-lifetime-test ] && \
        [ -n "${KANDELO_NATIVE_TEST_DIR:-}" ] || { echo 'ERROR: unexpected internal build argument' >&2; exit 2; }
fi
source "$REPO_ROOT/sdk/activate.sh"
export WASM_POSIX_SYSROOT="$(kandelo_package_prepare_private_sysroot node-core "$REPO_ROOT/sysroot" \
    libcxx libuv spidermonkey-core v8-tracing node-libffi kandelo-ffi-adapter)"
NODE_SOURCE="$WASM_POSIX_DEP_WORK_DIR/node-source"
kandelo_package_stage_source_dependency node-core-source "$NODE_SOURCE" "$WASM_POSIX_DEP_WORK_DIR"
BRIDGE="$WASM_POSIX_DEP_WORK_DIR/node-engine-bridge"
python3 "$SCRIPT_DIR/bridge/build-bridge.py" --repository "$REPO_ROOT" \
    --work "$WASM_POSIX_DEP_WORK_DIR/native-bridge" --node-source "$NODE_SOURCE" \
    --core "${WASM_POSIX_DEP_SPIDERMONKEY_CORE_DIR:?}" --libcxx "${WASM_POSIX_DEP_LIBCXX_DIR:?}" \
    --libuv "${WASM_POSIX_DEP_LIBUV_DIR:?}" --tracing "${WASM_POSIX_DEP_V8_TRACING_DIR:?}" \
    --output "$BRIDGE"
# The adapter is this recipe's own build output, installed only in its private
# sysroot. It is not a separate package or an independently exported SDK.
cp -R "$BRIDGE/include/." "$WASM_POSIX_SYSROOT/include/"
cp -R "$BRIDGE/lib/." "$WASM_POSIX_SYSROOT/lib/"
export KANDELO_NODE_ENGINE_CONFIGURATION="$WASM_POSIX_DEP_WORK_DIR/node-engine-configuration"
python3 "$SCRIPT_DIR/check-engine-sdk.py" \
    --core "$WASM_POSIX_DEP_SPIDERMONKEY_CORE_DIR" --bridge "$BRIDGE" \
    --tracing "$WASM_POSIX_DEP_V8_TRACING_DIR" --sysroot "$WASM_POSIX_SYSROOT" \
    --output "$KANDELO_NODE_ENGINE_CONFIGURATION"
bash "$SCRIPT_DIR/build-node-profile.sh"
