#!/usr/bin/env bash
set -euo pipefail

# Build wasm-fork-instrument for wasm32-unknown-kandelo-std from this
# repository's crates/fork-instrument, in resolver-owned roots.
#
# The crate lives in the repository workspace, whose other members (the
# kernel, xtask, ...) target other platforms. Copy just the instrumenter and
# its one path dependency into a two-member workspace under the work dir, so
# nothing is written to the checkout and Cargo resolves only their graph
# against the repository's Cargo.lock.

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"

# shellcheck source=/dev/null
source "$REPO_ROOT/scripts/package-build-roots.sh"
kandelo_package_prepare_build_roots "$SCRIPT_DIR" wasm32
WORK_DIR="$KANDELO_PACKAGE_WORK_DIR"
TRIPLE="wasm32-unknown-kandelo-std"

for tool in cargo rustc wasm32posix-cc; do
    command -v "$tool" >/dev/null || { echo "ERROR: $tool not found; enter scripts/dev-shell.sh" >&2; exit 1; }
done

SRC_DIR="$WORK_DIR/src"
rm -rf "$SRC_DIR"
mkdir -p "$SRC_DIR/crates"
cp -R "$REPO_ROOT/crates/fork-instrument" "$SRC_DIR/crates/fork-instrument"
cp -R "$REPO_ROOT/crates/shared" "$SRC_DIR/crates/shared"
rm -rf "$SRC_DIR/crates/fork-instrument/target" "$SRC_DIR/crates/shared/target"
cp "$REPO_ROOT/Cargo.lock" "$SRC_DIR/Cargo.lock"
# The workspace package fields and release profile the members inherit,
# copied from the repository's Cargo.toml.
{
    printf '[workspace]\nresolver = "2"\nmembers = ["crates/shared", "crates/fork-instrument"]\n\n'
    sed -n '/^\[workspace.package\]/,/^$/p' "$REPO_ROOT/Cargo.toml"
    sed -n '/^\[profile.release\]/,/^$/p' "$REPO_ROOT/Cargo.toml"
} > "$SRC_DIR/Cargo.toml"

# Private Rust sysroot (prebuilt std for the Kandelo target).
RUST_DIR="$WORK_DIR/rust"
KANDELO_RUST_DIR="$RUST_DIR" bash "$REPO_ROOT/scripts/build-rust-sysroot.sh"
KANDELO_RUSTC="$RUST_DIR/rustc-kandelo"
[ -x "$KANDELO_RUSTC" ] || { echo "ERROR: rustc wrapper missing at $KANDELO_RUSTC" >&2; exit 1; }

# A private CARGO_HOME holding the vendored-source config. It and the Kandelo
# rustc apply to the two cargo commands below only: install_local_binary
# later runs the repository's own host tools through cargo.
PACKAGE_CARGO_HOME="$WORK_DIR/cargo-home"
mkdir -p "$PACKAGE_CARGO_HOME"
VENDOR_DIR="$WORK_DIR/vendor"
echo "==> Vendoring crates from Cargo.lock..."
(cd "$SRC_DIR" && CARGO_HOME="$PACKAGE_CARGO_HOME" cargo vendor --versioned-dirs "$VENDOR_DIR" \
    > "$PACKAGE_CARGO_HOME/config.toml")

TARGET_DIR="$WORK_DIR/target"
# The private sysroot's prebuilt std carries no LLVM bitcode, so the
# workspace release profile's LTO cannot run for this target.
echo "==> Building wasm-fork-instrument for $TRIPLE..."
(cd "$SRC_DIR" && CARGO_HOME="$PACKAGE_CARGO_HOME" RUSTC="$KANDELO_RUSTC" \
    RUST_LIBC_UNSTABLE_MUSL_V1_2_3=1 CARGO_PROFILE_RELEASE_LTO=false cargo build --locked --offline --release \
    --target "$TRIPLE" --target-dir "$TARGET_DIR" \
    -p fork-instrument --bin wasm-fork-instrument)
OUT_BIN="$TARGET_DIR/$TRIPLE/release/wasm-fork-instrument.wasm"
[ -f "$OUT_BIN" ] || { echo "ERROR: wasm-fork-instrument.wasm not built" >&2; exit 1; }

cd "$REPO_ROOT"
if [ -n "${WASM_POSIX_DEP_WORK_DIR:-}" ] && [ -n "${WASM_POSIX_DEP_OUT_DIR:-}" ]; then
    export WASM_POSIX_INSTALL_LOCAL_MIRROR=0
    export WASM_POSIX_INSTALL_FORK_INSTRUMENTATION=auto
fi
source "$REPO_ROOT/scripts/install-local-binary.sh"
install_local_binary wasm-fork-instrument "$OUT_BIN" wasm-fork-instrument.wasm
