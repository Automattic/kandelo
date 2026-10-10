#!/usr/bin/env bash
#
# Build rsvg-convert.wasm (librsvg's command-line converter) for
# wasm32-posix-kernel.
#
# Upstream builds rsvg-convert from meson by running `cargo build --bin
# rsvg-convert`, then copies `rsvg-convert` from the cargo target dir; a
# Kandelo executable is `rsvg-convert.wasm` (the target's exe suffix), so
# this script runs that cargo build itself, in the environment
# sdk/rust/build-env.sh prepares (the one meson would pass).
#
# Honors the dep-resolver build-script contract (see
# docs/package-management.md): WASM_POSIX_DEP_VERSION / _SOURCE_URL /
# _SOURCE_SHA256 / _PKG_CONFIG_PATH from `cargo xtask build-deps resolve
# rsvg-convert`; the program is installed with install_local_binary.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"
source "$REPO_ROOT/scripts/package-build-roots.sh"
kandelo_package_load_source_metadata "$SCRIPT_DIR"
# shellcheck source=/dev/null
kandelo_package_prepare_build_roots "$SCRIPT_DIR" wasm32
WORK_DIR="$KANDELO_PACKAGE_WORK_DIR"
SRC_DIR="$WORK_DIR/librsvg-src"
VERIFIED_SOURCE_DIR="${WASM_POSIX_DEP_SOURCE_DIR:-}"

VERSION="$WASM_POSIX_DEP_VERSION"
SERIES="${VERSION%.*}"
SOURCE_URL="$WASM_POSIX_DEP_SOURCE_URL"
SOURCE_SHA256="$WASM_POSIX_DEP_SOURCE_SHA256"

for tool in wasm32posix-cc cargo rustc; do
    if ! command -v "$tool" &>/dev/null; then
        echo "ERROR: $tool not found. Enter scripts/dev-shell.sh." >&2
        exit 1
    fi
done
DEP_PKG_CONFIG_PATH="${WASM_POSIX_DEP_PKG_CONFIG_PATH:?WASM_POSIX_DEP_PKG_CONFIG_PATH not set (must be invoked via cargo xtask build-deps resolve rsvg-convert)}"

# Always fresh: sdk/rust/build-env.sh rewrites Cargo.lock.
rm -rf "$SRC_DIR"
echo "==> Staging verified librsvg $VERSION source..."
kandelo_package_stage_verified_source rsvg-convert "$SRC_DIR" "$VERIFIED_SOURCE_DIR" \
    "$SOURCE_URL" "$SOURCE_SHA256" "$WORK_DIR"

TARGET_DIR="$WORK_DIR/target"
OUT_BIN="$TARGET_DIR/wasm32-unknown-kandelo-std/release/rsvg-convert.wasm"
# A subshell: the environment sdk/rust/build-env.sh sets (CARGO_HOME with the
# librsvg crate overrides, offline, the sysroot's rustc) is for this
# build only, not for the repo's own cargo in install_local_binary.
(
    # shellcheck source=../../../sdk/rust/build-env.sh
    source "$REPO_ROOT/sdk/rust/build-env.sh"
    kandelo_rust_build_env "$SRC_DIR" "$WORK_DIR" "$DEP_PKG_CONFIG_PATH" \
        "$REPO_ROOT/packages/registry/librsvg/patches"
    echo "==> Building rsvg-convert..."
    cd "$SRC_DIR"
    cargo build --locked --release \
        --target "$KANDELO_RUST_TARGET" --target-dir "$TARGET_DIR" \
        -p rsvg_convert --bin rsvg-convert
)

[ -f "$OUT_BIN" ] || { echo "ERROR: rsvg-convert.wasm not built" >&2; exit 1; }
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
install_local_binary rsvg-convert "$OUT_BIN" rsvg-convert.wasm
