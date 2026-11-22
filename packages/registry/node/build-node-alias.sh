#!/usr/bin/env bash
# Preserve the existing package ID without compiling the same runtime twice.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$HERE/../../.." && pwd)"
if [ "${WASM_POSIX_DEP_NAME:?resolver must identify the alias package}" != node ] ||
   [ "${WASM_POSIX_DEP_TARGET_ARCH:-wasm32}" != wasm32 ]; then
    echo 'ERROR: node alias requires its normal wasm32 package contract' >&2; exit 2
fi
source "$REPO_ROOT/scripts/package-build-roots.sh"
kandelo_package_prepare_build_roots "$HERE" wasm32
: "${WASM_POSIX_DEP_SPIDERMONKEY_NODE_DIR:?declare the canonical executable dependency}"
install -m755 "$WASM_POSIX_DEP_SPIDERMONKEY_NODE_DIR/node.wasm" \
    "$KANDELO_PACKAGE_OUT_DIR/node.wasm"
