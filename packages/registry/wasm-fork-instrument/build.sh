#!/usr/bin/env bash
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
root="$(cd "$here/../../.." && pwd)"
source "$root/scripts/package-build-roots.sh"
kandelo_package_prepare_build_roots "$here" wasm32
work="$KANDELO_PACKAGE_WORK_DIR"
src="$work/src"
triple=wasm32-unknown-kandelo-std
source "$root/sdk/activate.sh"
mkdir -p "$src/crates"
cp -R "$root/crates/fork-instrument" "$src/crates/fork-instrument"
cp -R "$root/crates/program-abi" "$src/crates/program-abi"
cp -R "$root/crates/wasm-artifact" "$src/crates/wasm-artifact"
cp "$root/Cargo.lock" "$src/Cargo.lock"
awk '/^\[dev-dependencies\]/ { skip = 1; next } /^\[/ { skip = 0 } !skip' \
  "$root/crates/fork-instrument/Cargo.toml" > "$src/crates/fork-instrument/Cargo.toml"
{
  printf '[workspace]\nresolver = "2"\nexclude = [".kandelo-rust", ".kandelo-patched-crates", ".kandelo-vendor"]\nmembers = ["crates/fork-instrument", "crates/program-abi", "crates/wasm-artifact"]\n\n'
  sed -n '/^\[workspace.package\]/,/^$/p' "$root/Cargo.toml"
  sed -n '/^\[profile.release\]/,/^$/p' "$root/Cargo.toml"
} > "$src/Cargo.toml"
(
  source "$root/scripts/package-rust-build-env.sh"
  kandelo_package_rust_build_env "$root" "$src" "$work" "$here/patches"
  export CARGO_PROFILE_RELEASE_LTO=false
  export CC_wasm32_unknown_kandelo_std=wasm32posix-cc
  export AR_wasm32_unknown_kandelo_std=llvm-ar
  cd "$src"
  cargo build --locked --release -p fork-instrument --bin wasm-fork-instrument \
    --target "$triple" --target-dir "$work/target"
)
export WASM_POSIX_INSTALL_LOCAL_MIRROR=0
export WASM_POSIX_INSTALL_FORK_INSTRUMENTATION=auto
source "$root/scripts/install-local-binary.sh"
install_local_binary wasm-fork-instrument "$work/target/$triple/release/wasm-fork-instrument.wasm" wasm-fork-instrument.wasm
