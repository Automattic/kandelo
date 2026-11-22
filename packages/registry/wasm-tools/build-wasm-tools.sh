#!/usr/bin/env bash
# Build the wasm-tools CLI for Kandelo with the Rust target, with upstream's
# default subcommands.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$HERE/../../.." && pwd)"
source "$REPO_ROOT/scripts/package-build-roots.sh"
kandelo_package_load_source_metadata "$HERE"
kandelo_package_prepare_build_roots "$HERE" wasm32
WORK="$KANDELO_PACKAGE_WORK_DIR"
SRC="$WORK/wasm-tools-src"
source "$REPO_ROOT/sdk/activate.sh"
kandelo_package_stage_primary_source wasm-tools "$SRC" "$WORK"
(
    source "$REPO_ROOT/scripts/package-rust-build-env.sh"
    kandelo_package_rust_build_env "$REPO_ROOT" "$SRC" "$WORK" "$HERE/patches"
    cd "$SRC"
    cargo build --locked --release --bin wasm-tools \
        --target wasm32-unknown-kandelo-std --target-dir "$WORK/target"
)
if [ -n "${WASM_POSIX_DEP_OUT_DIR:-}" ]; then
    export WASM_POSIX_INSTALL_LOCAL_MIRROR=0
    export WASM_POSIX_INSTALL_FORK_INSTRUMENTATION=auto
fi
source "$REPO_ROOT/scripts/install-local-binary.sh"
install_local_binary wasm-tools "$WORK/target/wasm32-unknown-kandelo-std/release/wasm-tools.wasm" wasm-tools.wasm
