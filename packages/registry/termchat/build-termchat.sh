#!/usr/bin/env bash
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$HERE/../../.." && pwd)"
source "$REPO_ROOT/scripts/package-build-roots.sh"
kandelo_package_load_source_metadata "$HERE"
kandelo_package_prepare_build_roots "$HERE" wasm32
WORK="$KANDELO_PACKAGE_WORK_DIR"
SRC="$WORK/termchat-src"
source "$REPO_ROOT/sdk/activate.sh"
kandelo_package_stage_primary_source termchat "$SRC" "$WORK"
(
    source "$REPO_ROOT/scripts/package-rust-build-env.sh"
    kandelo_package_rust_build_env "$REPO_ROOT" "$SRC" "$WORK" "$HERE/patches"
    cd "$SRC"
    # Chat and file transfer use Rust plus libc. The optional Linux webcam
    # feature requires V4L hardware and is not part of this package.
    cargo build --locked --release --no-default-features \
        --target wasm32-unknown-kandelo-std --target-dir "$WORK/target"
)
if [ -n "${WASM_POSIX_DEP_OUT_DIR:-}" ]; then
    export WASM_POSIX_INSTALL_LOCAL_MIRROR=0
    export WASM_POSIX_INSTALL_FORK_INSTRUMENTATION=auto
fi
source "$REPO_ROOT/scripts/install-local-binary.sh"
install_local_binary termchat "$WORK/target/wasm32-unknown-kandelo-std/release/termchat.wasm" termchat.wasm
install_local_runtime_file termchat "$HERE/sessions.json" sessions.json
