#!/usr/bin/env bash
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
repo="$(cd "$here/../../.." && pwd)"
source "$repo/scripts/package-build-roots.sh"
kandelo_package_load_source_metadata "$here"
kandelo_package_prepare_build_roots "$here" wasm32
work="$KANDELO_PACKAGE_WORK_DIR"
src="$work/cargo-source"
source "$repo/sdk/activate.sh"
kandelo_package_stage_primary_source cargo "$src" "$work"
for patch_file in "$here"/source-patches/*.patch; do
  patch --fuzz=0 -p1 -d "$src" < "$patch_file"
done
# Upstream's supported source-tarball version metadata, from the pinned commit.
printf '%s\n' eb9b60f1f6604b5e022c56be31692c215b8ba11d eb9b60f1f 2026-04-24 > "$src/git-commit-info"
(
  source "$repo/scripts/package-rust-build-env.sh"
  kandelo_package_rust_build_env "$repo" "$src" "$work" "$here/patches"
  export CC_wasm32_unknown_kandelo_std=wasm32posix-cc
  export CXX_wasm32_unknown_kandelo_std=wasm32posix-c++
  export AR_wasm32_unknown_kandelo_std=wasm32posix-ar
  export CFLAGS_wasm32_unknown_kandelo_std="-ffile-prefix-map=$work=/kandelo/build -ffile-prefix-map=$repo=/kandelo/source"
  export OPENSSL_DIR="${WASM_POSIX_DEP_OPENSSL_DIR:?missing declared openssl dependency}" OPENSSL_STATIC=1
  export PKG_CONFIG_ALLOW_CROSS=1 PKG_CONFIG_ALL_STATIC=1 PKG_CONFIG_PATH=
  export PKG_CONFIG_LIBDIR="${WASM_POSIX_DEP_LIBCURL_DIR:?missing declared libcurl dependency}/lib/pkgconfig:${WASM_POSIX_DEP_ZLIB_DIR:?missing declared zlib dependency}/lib/pkgconfig:$OPENSSL_DIR/lib/pkgconfig"
  # Use the normal release optimization level for both Rust and cc-rs native
  # dependencies. At O1 libgit2's generated llhttp parser carries nearly
  # 25,000 Wasm locals into post-link optimization; O3 removes that shape.
  export CARGO_PROFILE_RELEASE_OPT_LEVEL=3 CARGO_PROFILE_RELEASE_DEBUG=0
  export CARGO_PROFILE_RELEASE_LTO=false CARGO_PROFILE_RELEASE_CODEGEN_UNITS=16
  export CFG_RELEASE=1.97.0-nightly CFG_RELEASE_CHANNEL=nightly
  cd "$src"
  cargo build --locked --release -j 4 -p cargo --bin cargo --features vendored-libgit2 \
    --target wasm32-unknown-kandelo-std --target-dir "$work/target"
)
export WASM_POSIX_INSTALL_LOCAL_MIRROR=0 WASM_POSIX_INSTALL_FORK_INSTRUMENTATION=auto
export BINARYEN_CORES=1
source "$repo/scripts/install-local-binary.sh"
# Conservative full fork coverage; optional parameter/sink refinement is
# expensive on this large graph. Post-link optimization and validation stay on.
"$repo/scripts/run-wasm-fork-instrument.sh" \
  "$work/target/wasm32-unknown-kandelo-std/release/cargo.wasm" --no-sinks -o "$work/cargo.wasm"
install_local_binary cargo "$work/cargo.wasm" cargo.wasm
