#!/usr/bin/env bash
#
# Build rustdemo-check — a C program that links the rustdemo Rust library
# package. It proves a Rust-built library is a first-class package
# dependency: the resolver supplies rustdemo's install prefix, and this C
# program compiles against its header and links its static archive.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"
# shellcheck source=/dev/null
source "$REPO_ROOT/scripts/package-build-roots.sh"
kandelo_package_prepare_build_roots "$SCRIPT_DIR" wasm32
WORK_DIR="$KANDELO_PACKAGE_WORK_DIR"

# shellcheck source=/dev/null
source "$REPO_ROOT/sdk/activate.sh"

# --- rustdemo dependency ---
RUSTDEMO_DIR="${WASM_POSIX_DEP_RUSTDEMO_DIR:-}"
if [ -z "$RUSTDEMO_DIR" ]; then
    echo "==> Resolving rustdemo via cargo xtask build-deps..."
    HOST_TARGET="$(rustc -vV | awk '/^host/ {print $2}')"
    RUSTDEMO_DIR="$(cd "$REPO_ROOT" && cargo run -p xtask --target "$HOST_TARGET" --quiet -- build-deps resolve rustdemo)"
fi
[ -f "$RUSTDEMO_DIR/lib/librustdemo.a" ] || {
    echo "ERROR: rustdemo resolve returned '$RUSTDEMO_DIR' but lib/librustdemo.a missing" >&2
    exit 1
}
echo "==> rustdemo at $RUSTDEMO_DIR"

OUT_BIN="$WORK_DIR/rustdemo-check.wasm"
wasm32posix-cc \
    -I"$RUSTDEMO_DIR/include" \
    "$SCRIPT_DIR/src/main.c" \
    "$RUSTDEMO_DIR/lib/librustdemo.a" \
    -o "$OUT_BIN"

# shellcheck source=/dev/null
source "$REPO_ROOT/scripts/install-local-binary.sh"
install_local_binary rustdemo-check "$OUT_BIN" rustdemo-check.wasm
