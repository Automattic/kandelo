#!/usr/bin/env bash
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
repo="$(cd "$here/../../.." && pwd)"
source "$repo/scripts/package-build-roots.sh"
kandelo_package_prepare_build_roots "$here" wasm32
work="$KANDELO_PACKAGE_WORK_DIR"
src="$work/src"
project="$src/sdk/guest-rust"
mkdir -p "$project" "$src/crates"
cp "$repo/sdk/guest-rust/Cargo.toml" "$repo/sdk/guest-rust/Cargo.lock" "$project/"
cp -R "$repo/sdk/guest-rust/src" "$project/src"
for member in wasm-artifact program-abi; do
  cp -R "$repo/crates/$member" "$src/crates/$member"
  rm -rf "$src/crates/$member/target" "$src/crates/$member/tests"
  awk '/^\[dev-dependencies\]/ { skip = 1; next } /^\[/ { skip = 0 } !skip' \
    "$repo/crates/$member/Cargo.toml" > "$src/crates/$member/Cargo.toml"
done
{
  printf '[workspace]\nresolver = "2"\nmembers = ["crates/wasm-artifact", "crates/program-abi"]\nexclude = ["sdk/guest-rust"]\n\n'
  sed -n '/^\[workspace.package\]/,/^$/p' "$repo/Cargo.toml"
} > "$src/Cargo.toml"
source "$repo/sdk/activate.sh"
# Bind user executables to the same program surface as the SDK's packages.
# The resolver's prepared xtask is preferred; a standalone recipe builds it
# through the ordinary host Cargo path. Pass the snapshot explicitly so a
# relocated tool never supplies another checkout's ABI identity.
if [ -n "${WASM_POSIX_XTASK_BIN:-}" ]; then
  digest=$("$WASM_POSIX_XTASK_BIN" abi-program-digest "$repo/abi/snapshot.json")
else
  host=$(rustc -vV | sed -n 's/^host: //p')
  digest=$(cd "$repo" && cargo run --locked --release --quiet -p xtask --target "$host" -- abi-program-digest "$repo/abi/snapshot.json")
fi
[[ "$digest" =~ ^[0-9a-f]{64}$ ]] || { echo "invalid SDK program ABI digest: $digest" >&2; exit 1; }
export KANDELO_GUEST_PROGRAM_ABI_DIGEST="$digest"
(
  source "$repo/scripts/package-rust-build-env.sh"
  kandelo_package_rust_build_env "$repo" "$project" "$work" "$here/patches"
  export CARGO_PROFILE_RELEASE_LTO=false
  cd "$project"
  cargo build --locked --release --target wasm32-unknown-kandelo-std --target-dir "$work/target"
)
export WASM_POSIX_INSTALL_LOCAL_MIRROR=0 WASM_POSIX_INSTALL_FORK_INSTRUMENTATION=auto
source "$repo/scripts/install-local-binary.sh"
install_local_binary kandelo-rustc "$work/target/wasm32-unknown-kandelo-std/release/kandelo-rustc.wasm" kandelo-rustc.wasm
