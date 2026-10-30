#!/usr/bin/env bash
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
root="$(cd "$here/../../.." && pwd)"
source "$root/scripts/package-build-roots.sh"
kandelo_package_prepare_build_roots "$here" wasm32
source "$root/sdk/activate.sh"
wasm32posix-cc -O2 -Wall -Wextra "$here/control.c" -o "$KANDELO_PACKAGE_WORK_DIR/service-activity-control.wasm"
export WASM_POSIX_INSTALL_LOCAL_MIRROR=0
export WASM_POSIX_INSTALL_FORK_INSTRUMENTATION=auto
source "$root/scripts/install-local-binary.sh"
install_local_binary service-activity-tools "$KANDELO_PACKAGE_WORK_DIR/service-activity-control.wasm" service-activity-control.wasm
