#!/usr/bin/env bash
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
repo="$(cd "$here/../../.." && pwd)"
source "$repo/scripts/package-build-roots.sh"
kandelo_package_prepare_build_roots "$here" wasm32
work="$KANDELO_PACKAGE_WORK_DIR"
src="$work/src"
mkdir -p "$src"
cp "$repo/sdk/guest-rust/Cargo.toml" "$repo/sdk/guest-rust/Cargo.lock" "$src/"
cp -R "$repo/sdk/guest-rust/src" "$src/src"
source "$repo/sdk/activate.sh"
(
  source "$repo/scripts/package-rust-build-env.sh"
  kandelo_package_rust_build_env "$repo" "$src" "$work" "$here/patches"
  export CARGO_PROFILE_RELEASE_LTO=false
  cd "$src"
  cargo build --locked --release --target wasm32-unknown-kandelo-std --target-dir "$work/target"
)
export WASM_POSIX_INSTALL_LOCAL_MIRROR=0 WASM_POSIX_INSTALL_FORK_INSTRUMENTATION=auto
source "$repo/scripts/install-local-binary.sh"
install_local_binary kandelo-rustc "$work/target/wasm32-unknown-kandelo-std/release/kandelo-rustc.wasm" kandelo-rustc.wasm
