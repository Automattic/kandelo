#!/usr/bin/env bash
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"
source "$REPO_ROOT/scripts/package-build-roots.sh"
kandelo_package_prepare_build_roots "$SCRIPT_DIR" wasm32
: "${WASM_POSIX_DEP_WORK_DIR:?build through the normal resolver}"
: "${WASM_POSIX_DEP_OUT_DIR:?build through the normal resolver}"
: "${WASM_POSIX_DEP_SPIDERMONKEY_CORE_DIR:?declare the exact engine provider}"
: "${WASM_POSIX_DEP_LIBCXX_DIR:?declare libcxx}"
: "${WASM_POSIX_DEP_LIBUV_DIR:?declare libuv}"
: "${WASM_POSIX_DEP_V8_TRACING_DIR:?declare the native logger and portable V8 platform}"
source "$REPO_ROOT/sdk/activate.sh"
export WASM_POSIX_SYSROOT="$(kandelo_package_prepare_private_sysroot node-engine-bridge "$REPO_ROOT/sysroot" libcxx libuv v8-tracing)"
NODE_SOURCE="$KANDELO_PACKAGE_WORK_DIR/node-source"
kandelo_package_stage_source_dependency node-core-source "$NODE_SOURCE" "$KANDELO_PACKAGE_WORK_DIR"
python3 "$SCRIPT_DIR/build-bridge.py" --repository "$REPO_ROOT" \
    --work "$KANDELO_PACKAGE_WORK_DIR/native-bridge" --node-source "$NODE_SOURCE" \
    --core "$WASM_POSIX_DEP_SPIDERMONKEY_CORE_DIR" --libcxx "$WASM_POSIX_DEP_LIBCXX_DIR" \
    --libuv "$WASM_POSIX_DEP_LIBUV_DIR" --tracing "$WASM_POSIX_DEP_V8_TRACING_DIR" \
    --output "$WASM_POSIX_DEP_OUT_DIR"
