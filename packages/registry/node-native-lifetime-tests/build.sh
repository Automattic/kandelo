#!/usr/bin/env bash
# Unshipped test companion: original complete recipe, one private entrypoint.
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"
: "${WASM_POSIX_DEP_WORK_DIR:?build through the normal resolver}"
: "${WASM_POSIX_DEP_OUT_DIR:?build through the normal resolver}"
: "${WASM_POSIX_DEP_NAME:?resolver must identify this test package}"
if [ "$WASM_POSIX_DEP_NAME" != node-native-lifetime-tests ]; then
    echo 'ERROR: unexpected native lifetime test package' >&2; exit 2
fi
# Select the whole private test main at the normal recipe's one complete GYP
# make. Every provider, owner, registration and link input is unchanged. This
# avoids preparing a disposable executable and then repeating the same link
# and Wasm preparation after replacing main. The production recipe is unedited.
export KANDELO_NATIVE_TEST_DIR="$SCRIPT_DIR" KANDELO_NATIVE_TEST_REPO="$REPO_ROOT"
export KANDELO_NATIVE_REAL_MAKE="$(command -v make)"
make() {
    if [ "$PWD" = "$WASM_POSIX_DEP_WORK_DIR/node-source" ] && \
       [ "${1:-}" = -C ] && [ "${2:-}" = out ] && [ "${!#}" = node ]; then
        python3 "$KANDELO_NATIVE_TEST_DIR/prepare-test-main.py"
    fi
    "$KANDELO_NATIVE_REAL_MAKE" "$@"
}
export -f make
AUXILIARY="$WASM_POSIX_DEP_OUT_DIR/prepared-native-main"
mkdir "$AUXILIARY"
env -u WASM_POSIX_INSTALL_OUTPUT_METADATA \
    WASM_POSIX_DEP_NAME=node WASM_POSIX_DEP_OUT_DIR="$AUXILIARY" \
    bash "$REPO_ROOT/packages/registry/spidermonkey-node/build-spidermonkey-node.sh"
unset -f make
test -f "$WASM_POSIX_DEP_WORK_DIR/native-main-installed.json"
mv "$AUXILIARY" "$WASM_POSIX_DEP_WORK_DIR/prepared-native-main"
source "$REPO_ROOT/sdk/activate.sh"
source "$REPO_ROOT/scripts/install-local-binary.sh"
export WASM_POSIX_INSTALL_LOCAL_MIRROR=0
# The helper verifies the already prepared fork ABI and installs this declared
# diagnostic output. No production artifact/projection is overwritten.
WASM_POSIX_INSTALL_FORK_INSTRUMENTATION=auto install_local_binary \
    node-native-lifetime-tests "$WASM_POSIX_DEP_WORK_DIR/prepared-native-main/node.wasm" node-native-lifetime-tests.wasm
