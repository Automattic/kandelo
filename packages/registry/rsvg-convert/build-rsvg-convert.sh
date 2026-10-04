#!/usr/bin/env bash
#
# Build rsvg-convert.wasm (librsvg's command-line converter) for
# wasm32-posix-kernel.
#
# Upstream builds rsvg-convert from meson by running `cargo build --bin
# rsvg-convert`, then copies `rsvg-convert` from the cargo target dir; a
# Kandelo executable is `rsvg-convert.wasm` (the target's exe suffix), so
# this script runs that cargo build itself, in the environment
# rust-build-env.sh prepares (the one meson would pass).
#
# Honors the dep-resolver build-script contract (see
# docs/package-management.md): WASM_POSIX_DEP_VERSION / _SOURCE_URL /
# _SOURCE_SHA256 / _PKG_CONFIG_PATH from `cargo xtask build-deps resolve
# rsvg-convert`; the program is installed with install_local_binary.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"
# shellcheck source=/dev/null
source "$REPO_ROOT/scripts/package-build-roots.sh"
kandelo_package_prepare_build_roots "$SCRIPT_DIR" wasm32
WORK_DIR="$KANDELO_PACKAGE_WORK_DIR"
SRC_DIR="$WORK_DIR/librsvg-src"
VERIFIED_SOURCE_DIR="${WASM_POSIX_DEP_SOURCE_DIR:-}"

VERSION="${WASM_POSIX_DEP_VERSION:-2.63.2}"
SERIES="${VERSION%.*}"
SOURCE_URL="${WASM_POSIX_DEP_SOURCE_URL:-https://download.gnome.org/sources/librsvg/${SERIES}/librsvg-${VERSION}.tar.xz}"
SOURCE_SHA256="${WASM_POSIX_DEP_SOURCE_SHA256:-852b18e1a00b8605528825a27dc7748bff2a5dd254028f59dc22a34ea57e81b6}"

for tool in wasm32posix-cc cargo rustc; do
    if ! command -v "$tool" &>/dev/null; then
        echo "ERROR: $tool not found. Enter scripts/dev-shell.sh." >&2
        exit 1
    fi
done
DEP_PKG_CONFIG_PATH="${WASM_POSIX_DEP_PKG_CONFIG_PATH:?WASM_POSIX_DEP_PKG_CONFIG_PATH not set (must be invoked via cargo xtask build-deps resolve rsvg-convert)}"

# Always fresh: rust-build-env.sh rewrites Cargo.lock.
rm -rf "$SRC_DIR"
echo "==> Staging verified librsvg $VERSION source..."
kandelo_package_stage_verified_source rsvg-convert "$SRC_DIR" "$VERIFIED_SOURCE_DIR" \
    "$SOURCE_URL" "$SOURCE_SHA256" "$WORK_DIR"

TARGET_DIR="$WORK_DIR/target"
OUT_BIN="$TARGET_DIR/wasm32-unknown-kandelo-std/release/rsvg-convert.wasm"
# A subshell: the environment rust-build-env.sh sets (CARGO_HOME with the
# librsvg crate overrides, offline, the sysroot's rustc) is for this
# build only, not for the repo's own cargo in install_local_binary.
(
    # shellcheck source=../librsvg/rust-build-env.sh
    source "$REPO_ROOT/packages/registry/librsvg/rust-build-env.sh"
    librsvg_rust_build_env "$REPO_ROOT" "$SRC_DIR" "$WORK_DIR" "$DEP_PKG_CONFIG_PATH"
    echo "==> Building rsvg-convert..."
    cd "$SRC_DIR"
    cargo build --locked --release \
        --target "$LIBRSVG_RUST_TARGET" --target-dir "$TARGET_DIR" \
        -p rsvg_convert --bin rsvg-convert
)

[ -f "$OUT_BIN" ] || { echo "ERROR: rsvg-convert.wasm not built" >&2; exit 1; }
ls -lh "$OUT_BIN"

cd "$REPO_ROOT"
# shellcheck source=/dev/null
source "$REPO_ROOT/scripts/install-local-binary.sh"
install_local_binary rsvg-convert "$OUT_BIN" rsvg-convert.wasm
