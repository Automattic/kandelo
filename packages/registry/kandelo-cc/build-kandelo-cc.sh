#!/usr/bin/env bash
set -euo pipefail

# Build the SDK driver (crates/kandelo-cc) for wasm32-unknown-kandelo-std,
# in resolver-owned roots.
#
# The crate lives in the repository workspace, whose other members target
# other platforms. Copy just the driver into a one-member workspace under the
# work dir, so nothing is written to the checkout and Cargo resolves only its
# graph against the repository's Cargo.lock. Its dev-dependencies (the fork
# instrumenter its tests check the driver's output against) are dropped: they
# are not part of the program.

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"

# shellcheck source=/dev/null
source "$REPO_ROOT/scripts/package-build-roots.sh"
kandelo_package_load_source_metadata "$SCRIPT_DIR"
kandelo_package_prepare_build_roots "$SCRIPT_DIR" wasm32
WORK_DIR="$KANDELO_PACKAGE_WORK_DIR"
TRIPLE="wasm32-unknown-kandelo-std"

for tool in cargo rustc wasm32posix-cc; do
    command -v "$tool" >/dev/null || { echo "ERROR: $tool not found; enter scripts/dev-shell.sh" >&2; exit 1; }
done

SRC_DIR="$WORK_DIR/src"
rm -rf "$SRC_DIR"
mkdir -p "$SRC_DIR/crates"
cp -R "$REPO_ROOT/crates/kandelo-cc" "$SRC_DIR/crates/kandelo-cc"
rm -rf "$SRC_DIR/crates/kandelo-cc/target" "$SRC_DIR/crates/kandelo-cc/tests"
# Everything from [dev-dependencies] to the next table goes.
awk '/^\[dev-dependencies\]/ { skip = 1; next } /^\[/ { skip = 0 } !skip' \
    "$REPO_ROOT/crates/kandelo-cc/Cargo.toml" > "$SRC_DIR/crates/kandelo-cc/Cargo.toml"
cp "$REPO_ROOT/Cargo.lock" "$SRC_DIR/Cargo.lock"
# The workspace package fields and release profile the member inherits,
# copied from the repository's Cargo.toml.
{
    printf '[workspace]\nresolver = "2"\nmembers = ["crates/kandelo-cc"]\n\n'
    sed -n '/^\[workspace.package\]/,/^$/p' "$REPO_ROOT/Cargo.toml"
    sed -n '/^\[profile.release\]/,/^$/p' "$REPO_ROOT/Cargo.toml"
} > "$SRC_DIR/Cargo.toml"

# Private Rust sysroot (prebuilt std for the Kandelo target).
RUST_DIR="$WORK_DIR/rust"
KANDELO_RUST_DIR="$RUST_DIR" bash "$REPO_ROOT/scripts/build-rust-sysroot.sh"
export RUSTC="$RUST_DIR/rustc-kandelo"
export RUST_LIBC_UNSTABLE_MUSL_V1_2_3=1
[ -x "$RUSTC" ] || { echo "ERROR: rustc wrapper missing at $RUSTC" >&2; exit 1; }

# A private CARGO_HOME, so the vendored-source config below cannot leak into
# the repository's own cargo invocations (install_local_binary runs xtask).
export CARGO_HOME="$WORK_DIR/cargo-home"
mkdir -p "$CARGO_HOME"
VENDOR_DIR="$WORK_DIR/vendor"
echo "==> Vendoring crates from Cargo.lock..."
(cd "$SRC_DIR" && cargo vendor --versioned-dirs "$VENDOR_DIR" > "$CARGO_HOME/config.toml")

TARGET_DIR="$WORK_DIR/target"
echo "==> Building kandelo-cc for $TRIPLE..."
(cd "$SRC_DIR" && cargo build --offline --release \
    --target "$TRIPLE" --target-dir "$TARGET_DIR" \
    -p kandelo-cc --bin kandelo-cc)
OUT_BIN="$TARGET_DIR/$TRIPLE/release/kandelo-cc.wasm"
[ -f "$OUT_BIN" ] || { echo "ERROR: kandelo-cc.wasm not built" >&2; exit 1; }

cd "$REPO_ROOT"
if [ -n "${WASM_POSIX_DEP_WORK_DIR:-}" ] && [ -n "${WASM_POSIX_DEP_OUT_DIR:-}" ]; then
    export WASM_POSIX_INSTALL_LOCAL_MIRROR=0
    export WASM_POSIX_INSTALL_FORK_INSTRUMENTATION=auto
fi
source "$REPO_ROOT/scripts/install-local-binary.sh"
install_local_binary kandelo-cc "$OUT_BIN" kandelo-cc.wasm
