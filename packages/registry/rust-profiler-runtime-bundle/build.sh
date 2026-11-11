#!/usr/bin/env bash
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
repo="$(cd "$here/../../.." && pwd)"
source "$repo/scripts/package-build-roots.sh"
kandelo_package_prepare_build_roots "$here" wasm32
work="$KANDELO_PACKAGE_WORK_DIR"
runtime="${WASM_POSIX_DEP_RUST_PROFILER_RUNTIME_DIR:?missing matching profiler runtime}"
stage="$work/stage"
target_lib=lib/rustlib/wasm32-unknown-kandelo-std/lib
mkdir -p "$stage/$target_lib" "$stage/share/licenses/rust-profiler-runtime"
install -m644 "$runtime/$target_lib/libprofiler_builtins.rlib" "$stage/$target_lib/libprofiler_builtins.rlib"
cp "$repo/sdk/guest-rust/licenses/"* "$stage/share/licenses/rust-profiler-runtime/"
bash "$repo/images/vfs/scripts/create-deterministic-zip.sh" "$stage" "$work/rust-profiler-runtime.zip"
export WASM_POSIX_INSTALL_LOCAL_MIRROR=0 WASM_POSIX_INSTALL_FORK_INSTRUMENTATION=disabled
source "$repo/scripts/install-local-binary.sh"
install_local_binary rust-profiler-runtime-bundle "$work/rust-profiler-runtime.zip" rust-profiler-runtime.zip
