#!/usr/bin/env bash
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$HERE/../../.." && pwd)"
source "$REPO_ROOT/scripts/package-build-roots.sh"
kandelo_package_prepare_build_roots "$HERE" wasm32
kandelo_package_select_source_root "$REPO_ROOT"
SOURCE_ROOT="$KANDELO_PACKAGE_SOURCE_ROOT"
source "$REPO_ROOT/sdk/activate.sh"
export WASM_POSIX_SYSROOT="$REPO_ROOT/sysroot"
export WASM_POSIX_INSTALL_FORK_INSTRUMENTATION=disabled
if [ -n "${WASM_POSIX_DEP_OUT_DIR:-}" ]; then
    export WASM_POSIX_INSTALL_LOCAL_MIRROR=0
fi
source "$REPO_ROOT/scripts/install-local-binary.sh"
for program in bun-run bun-extract; do
    wasm32posix-cc -std=c11 -D_GNU_SOURCE -O2 -Wall -Wextra \
        "$SOURCE_ROOT/programs/$program.c" -o "$KANDELO_PACKAGE_WORK_DIR/$program.wasm"
    install_local_binary bun-run "$KANDELO_PACKAGE_WORK_DIR/$program.wasm" "$program.wasm"
done
install_local_runtime_file bun-run "$SOURCE_ROOT/runtime/bun-run/bun-run.js" bun-run.js
