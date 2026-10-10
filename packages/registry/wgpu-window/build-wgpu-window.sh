#!/usr/bin/env bash
#
# Build wgpu-window.wasm (programs/rust/wgpu-window) for
# wasm32-posix-kernel, with cargo in the environment
# sdk/rust/build-env.sh prepares.
#
# Honors the dep-resolver build-script contract (see
# docs/package-management.md): WASM_POSIX_DEP_PKG_CONFIG_PATH from
# `cargo xtask build-deps resolve wgpu-window`; the program is installed
# with install_local_binary.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"
# shellcheck source=/dev/null
source "$REPO_ROOT/scripts/package-build-roots.sh"
kandelo_package_prepare_build_roots "$SCRIPT_DIR" wasm32
kandelo_package_select_source_root "$REPO_ROOT"
SOURCE_ROOT="$KANDELO_PACKAGE_SOURCE_ROOT"
WORK_DIR="$KANDELO_PACKAGE_WORK_DIR"
SRC_DIR="$WORK_DIR/wgpu-window-src"

for tool in wasm32posix-cc cargo rustc; do
    if ! command -v "$tool" &>/dev/null; then
        echo "ERROR: $tool not found. Enter scripts/dev-shell.sh." >&2
        exit 1
    fi
done
DEP_PKG_CONFIG_PATH="${WASM_POSIX_DEP_PKG_CONFIG_PATH:?WASM_POSIX_DEP_PKG_CONFIG_PATH not set (must be invoked via cargo xtask build-deps resolve wgpu-window)}"

for lib in libEGL libGLESv2; do
    if [ ! -f "$REPO_ROOT/sysroot/lib/$lib.a" ]; then
        echo "ERROR: $lib.a missing from the SDK sysroot." >&2
        echo "Run: scripts/dev-shell.sh bash scripts/build-musl.sh" >&2
        exit 1
    fi
done

# Always fresh: sdk/rust/build-env.sh rewrites Cargo.lock.
rm -rf "$SRC_DIR"
mkdir -p "$SRC_DIR"
cp -R "$SOURCE_ROOT/programs/rust/wgpu-window/." "$SRC_DIR/"

TARGET_DIR="$WORK_DIR/target"
OUT_BIN="$TARGET_DIR/wasm32-unknown-kandelo-std/release/wgpu-window.wasm"
# A subshell: the environment sdk/rust/build-env.sh sets (CARGO_HOME with
# the crate overrides, offline, the sysroot's rustc) is for this build
# only, not for the repo's own cargo in install_local_binary.
(
    # shellcheck source=../../../sdk/rust/build-env.sh
    source "$REPO_ROOT/sdk/rust/build-env.sh"
    kandelo_rust_build_env "$SRC_DIR" "$WORK_DIR" "$DEP_PKG_CONFIG_PATH" "$SCRIPT_DIR/patches"
    echo "==> Building wgpu-window..."
    cd "$SRC_DIR"
    cargo build --locked --release \
        --target "$KANDELO_RUST_TARGET" --target-dir "$TARGET_DIR"
)

[ -f "$OUT_BIN" ] || { echo "ERROR: wgpu-window.wasm not built" >&2; exit 1; }
ls -lh "$OUT_BIN"

cd "$REPO_ROOT"
# A resolver caller owns the declared work and output roots. Keep the
# reviewed checkout read-only and suppress the developer-only local mirror.
if [ -n "${WASM_POSIX_DEP_WORK_DIR:-}" ] && [ -n "${WASM_POSIX_DEP_OUT_DIR:-}" ]; then
    export WASM_POSIX_INSTALL_LOCAL_MIRROR=0
    export WASM_POSIX_INSTALL_FORK_INSTRUMENTATION=auto
fi
# shellcheck source=/dev/null
source "$REPO_ROOT/scripts/install-local-binary.sh"
install_local_binary wgpu-window "$OUT_BIN" wgpu-window.wasm
