#!/usr/bin/env bash
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
repo="$(cd "$here/../../.." && pwd)"
source "$repo/scripts/package-build-roots.sh"
kandelo_package_load_source_metadata "$here"
kandelo_package_prepare_build_roots "$here" wasm32
work="$KANDELO_PACKAGE_WORK_DIR"
src="$work/rust-source"
libcxx="${WASM_POSIX_DEP_LIBCXX_DIR:?missing declared libcxx dependency}"
: "${WASM_POSIX_DEP_RUST_LLVM_DIR:?missing declared rust-llvm dependency}"
source "$repo/sdk/activate.sh"
# rustc's internal APIs and the standard-library metadata require the exact
# compiler revision used to build this source tree, not merely its version.
commit=ca9a134e0985765ded9cfdde4030a5df4db7e2bd
test "$(rustc -vV | sed -n 's/^commit-hash: //p')" = "$commit" || {
  echo "rustc guest bootstrap requires the repository's pinned compiler ($commit)" >&2
  exit 1
}
kandelo_package_stage_primary_source rustc "$src" "$work"
for patch_file in "$here"/source-patches/*.patch; do
  patch --fuzz=0 -p1 -d "$src" < "$patch_file"
done
# Use the exact compiler libraries for all tools, without a host rustc-dev
# sysroot or optional upstream workspace submodules.
python3 "$here/prepare-tools.py" "$src"
export WASM_POSIX_DEP_WORK_DIR="$work" WASM_POSIX_DEP_LIBCXX_DIR="$libcxx"
export WASM_POSIX_SYSROOT
WASM_POSIX_SYSROOT="$(kandelo_package_prepare_private_sysroot rustc "$repo/sysroot" libcxx)"
(
  source "$repo/scripts/package-rust-build-env.sh"
  kandelo_package_rust_build_env "$repo" "$src" "$work" "$here/patches"
  export CFG_VERSION='1.97.0-nightly (ca9a134e0 2026-04-26)'
  export CFG_RELEASE=1.97.0-nightly CFG_RELEASE_CHANNEL=nightly
  export DOC_RUST_LANG_ORG_CHANNEL=nightly
  export CFG_VER_HASH="$commit" CFG_VER_DATE=2026-04-26
  export CFG_COMPILER_HOST_TRIPLE=wasm32-unknown-kandelo-std
  export CFG_DEFAULT_CODEGEN_BACKEND=llvm CFG_LIBDIR_RELATIVE=lib RUSTC_INSTALL_BINDIR=bin
  export RUSTC_BOOTSTRAP=1
  export CC_wasm32_unknown_kandelo_std="$(command -v wasm32posix-cc)"
  export CXX_wasm32_unknown_kandelo_std="$(command -v wasm32posix-c++)"
  export AR_wasm32_unknown_kandelo_std="$(command -v wasm32posix-ar)"
  case "$(rustc -vV | sed -n 's/^host: //p')" in
    *-apple-darwin) export REAL_LIBRARY_PATH_VAR=DYLD_LIBRARY_PATH ;;
    *) export REAL_LIBRARY_PATH_VAR=LD_LIBRARY_PATH ;;
  esac
  export LLVM_CONFIG="$here/llvm-config.py" LLVM_USE_LIBCXX=1
  export LLVM_STATIC_STDCPP="$libcxx/lib/libc++.a"
  export LLVM_LINKER_FLAGS="-L$libcxx/lib -lc++abi"
  export CARGO_PROFILE_RELEASE_OPT_LEVEL=1 CARGO_PROFILE_RELEASE_DEBUG=0
  export CARGO_PROFILE_RELEASE_LTO=false CARGO_PROFILE_RELEASE_CODEGEN_UNITS=16
  cd "$src"
  cargo build --locked --release -j 3 \
    -p rustc-main -p rustdoc-tool -p rustfmt-nightly -p clippy \
    --features rustc-main/llvm \
    --bin rustc-main --bin rustdoc_tool_binary --bin rustfmt \
    --bin cargo-fmt --bin cargo-clippy --bin clippy-driver \
    --target wasm32-unknown-kandelo-std --target-dir "$work/target"
)
export WASM_POSIX_INSTALL_LOCAL_MIRROR=0
export WASM_POSIX_INSTALL_FORK_INSTRUMENTATION=auto
source "$repo/scripts/install-local-binary.sh"
# The conservative mode instruments the complete fork-reachable graph. The
# optional parameter/sink refinement does not currently finish promptly on
# rustc's large structured functions; no continuation coverage is omitted.
# Keep post-link optimization and validation, with bounded host concurrency.
export BINARYEN_CORES=1
for tool in rustc rustdoc rustfmt cargo-fmt cargo-clippy clippy-driver; do
  binary="$tool"
  case "$tool" in
    rustc) binary=rustc-main ;;
    rustdoc) binary=rustdoc_tool_binary ;;
  esac
  "$repo/scripts/run-wasm-fork-instrument.sh" \
    "$work/target/wasm32-unknown-kandelo-std/release/$binary.wasm" \
    --no-sinks -o "$work/$tool.wasm"
  install_local_binary rustc "$work/$tool.wasm" "$tool.wasm"
done
# Ship the matching prebuilt std separately; projects do not need rust-src.
python3 - "$src/.kandelo-rust/sysroot/lib/rustlib/wasm32-unknown-kandelo-std" "$work/rust-std.zip" <<'PY'
from pathlib import Path
import sys, zipfile
root = Path(sys.argv[1])
with zipfile.ZipFile(sys.argv[2], 'w', compression=zipfile.ZIP_DEFLATED) as archive:
    for path in sorted(root.rglob('*')):
        if path.is_file():
            entry = zipfile.ZipInfo('lib/rustlib/' + root.name + '/' + path.relative_to(root).as_posix(), (1980, 1, 1, 0, 0, 0))
            entry.external_attr = 0o100644 << 16
            entry.compress_type = zipfile.ZIP_DEFLATED
            archive.writestr(entry, path.read_bytes())
PY
install_local_runtime_file rustc "$work/rust-std.zip" rust-std.zip
