#!/usr/bin/env bash
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
repo="$(cd "$here/../../.." && pwd)"
source "$repo/scripts/package-build-roots.sh"
kandelo_package_prepare_build_roots "$here" wasm32
work="$KANDELO_PACKAGE_WORK_DIR"
stage="$work/stage"
mkdir -p "$stage/bin" "$stage/libexec"
unzip -q "${WASM_POSIX_DEP_KANDELO_SDK_BROWSER_BUNDLE_DIR:?missing C SDK}/kandelo-sdk.zip" -d "$stage"
unzip -q "${WASM_POSIX_DEP_RUSTC_DIR:?missing compiler}/rust-std.zip" -d "$stage"
install -m755 "$WASM_POSIX_DEP_RUSTC_DIR/rustc.wasm" "$stage/libexec/rustc"
install -m755 "${WASM_POSIX_DEP_CARGO_DIR:?missing Cargo}/cargo.wasm" "$stage/bin/cargo"
install -m755 "${WASM_POSIX_DEP_KANDELO_RUSTC_DIR:?missing compiler entry point}/kandelo-rustc.wasm" "$stage/bin/kandelo-rustc"
install -m755 "${WASM_POSIX_DEP_WASM_FORK_INSTRUMENT_DIR:?missing fork instrumenter}/wasm-fork-instrument.wasm" "$stage/bin/wasm-fork-instrument"
ln -s kandelo-rustc "$stage/bin/rustc"
ln -s kandelo-rustc "$stage/bin/wasm32posix-rustc"
mkdir -p "$stage/share/licenses/rust-cargo"
cp "$repo/sdk/guest-rust/licenses/"* "$stage/share/licenses/rust-cargo/"
bash "$repo/images/vfs/scripts/create-deterministic-zip.sh" "$stage" "$work/kandelo-rust-sdk.zip"
export WASM_POSIX_INSTALL_LOCAL_MIRROR=0 WASM_POSIX_INSTALL_FORK_INSTRUMENTATION=disabled
source "$repo/scripts/install-local-binary.sh"
install_local_binary kandelo-rust-sdk "$work/kandelo-rust-sdk.zip" kandelo-rust-sdk.zip
