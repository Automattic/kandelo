#!/usr/bin/env bash
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$HERE/../../.." && pwd)"
source "$REPO_ROOT/scripts/package-build-roots.sh"
kandelo_package_load_source_metadata "$HERE"
kandelo_package_prepare_build_roots "$HERE" wasm32
WORK="$KANDELO_PACKAGE_WORK_DIR"
SRC="$WORK/ttfx-src"
source "$REPO_ROOT/sdk/activate.sh"
kandelo_package_stage_primary_source ttfx "$SRC" "$WORK"
(
    source "$REPO_ROOT/scripts/package-rust-build-env.sh"
    kandelo_package_rust_build_env "$REPO_ROOT" "$SRC" "$WORK" "$HERE/patches"
    cd "$SRC"
    cargo build --locked --release \
        --target wasm32-unknown-kandelo-std --target-dir "$WORK/target"
)
if [ -n "${WASM_POSIX_DEP_OUT_DIR:-}" ]; then
    export WASM_POSIX_INSTALL_LOCAL_MIRROR=0
    # ttfx draws frames and never forks.
    export WASM_POSIX_INSTALL_FORK_INSTRUMENTATION=disabled
fi
source "$REPO_ROOT/scripts/install-local-binary.sh"
install_local_binary ttfx "$WORK/target/wasm32-unknown-kandelo-std/release/ttfx.wasm" ttfx.wasm
