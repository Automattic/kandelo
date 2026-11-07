#!/usr/bin/env bash
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$HERE/../../.." && pwd)"
source "$REPO_ROOT/scripts/package-build-roots.sh"
kandelo_package_load_source_metadata "$HERE"
kandelo_package_prepare_build_roots "$HERE" wasm32
WORK="$KANDELO_PACKAGE_WORK_DIR"
SRC="$WORK/harper-src"
source "$REPO_ROOT/sdk/activate.sh"
kandelo_package_stage_primary_source harper "$SRC" "$WORK"
(
    source "$REPO_ROOT/scripts/package-rust-build-env.sh"
    kandelo_package_rust_build_env "$REPO_ROOT" "$SRC" "$WORK" "$HERE/patches"
    cd "$SRC"
    # Tree-sitter's native parsers must use the guest SDK, not host Clang.
    export CC_wasm32_unknown_kandelo_std="$(command -v wasm32posix-cc)"
    export CXX_wasm32_unknown_kandelo_std="$(command -v wasm32posix-c++)"
    export AR_wasm32_unknown_kandelo_std="$(command -v wasm32posix-ar)"
    # Burn's no-std ndarray backend uses const-random's compile-time seed.
    # Its documented reproducible-build option leaves runtime entropy alone.
    export CONST_RANDOM_SEED="$WASM_POSIX_DEP_SOURCE_SHA256"
    cargo build --locked --release --target wasm32-unknown-kandelo-std \
        --target-dir "$WORK/target" -p harper-cli -p harper-ls
)
if [ -n "${WASM_POSIX_DEP_OUT_DIR:-}" ]; then
    export WASM_POSIX_INSTALL_LOCAL_MIRROR=0
    export WASM_POSIX_INSTALL_FORK_INSTRUMENTATION=auto
fi
source "$REPO_ROOT/scripts/install-local-binary.sh"
for program in harper-cli harper-ls; do
    install_local_binary harper "$WORK/target/wasm32-unknown-kandelo-std/release/$program.wasm" "$program.wasm"
done
