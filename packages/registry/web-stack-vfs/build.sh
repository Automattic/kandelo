#!/usr/bin/env bash
set -euo pipefail
root="$(cd "$(dirname "$0")/../../.." && pwd)"
: "${WASM_POSIX_DEP_WORK_DIR:?image families require resolver-owned work space}"
: "${WASM_POSIX_DEP_OUT_DIR:?image families require resolver-owned output space}"
cd "$root"
node --import tsx/esm images/vfs/scripts/build-image-families.ts web-stack "$WASM_POSIX_DEP_WORK_DIR/web-stack-vfs.vfs.zst"
export WASM_POSIX_INSTALL_LOCAL_MIRROR=0
export WASM_POSIX_INSTALL_FORK_INSTRUMENTATION=disabled
source scripts/install-local-binary.sh
install_local_binary web-stack-vfs "$WASM_POSIX_DEP_WORK_DIR/web-stack-vfs.vfs.zst"
