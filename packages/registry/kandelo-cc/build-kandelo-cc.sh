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
    printf '[workspace]\nresolver = "2"\nexclude = [".kandelo-rust", ".kandelo-patched-crates", ".kandelo-vendor"]\nmembers = ["crates/kandelo-cc"]\n\n'
    sed -n '/^\[workspace.package\]/,/^$/p' "$REPO_ROOT/Cargo.toml"
    sed -n '/^\[profile.release\]/,/^$/p' "$REPO_ROOT/Cargo.toml"
} > "$SRC_DIR/Cargo.toml"

TARGET_DIR="$WORK_DIR/target"
(
    # Kandelo's Rust build environment (private std, the libc fork, vendored
    # crates, remapped paths), kept to this subshell: install_local_binary
    # later runs the repository's own host tools through cargo.
    # shellcheck source=/dev/null
    source "$REPO_ROOT/scripts/package-rust-build-env.sh"
    kandelo_package_rust_build_env "$REPO_ROOT" "$SRC_DIR" "$WORK_DIR" "$SCRIPT_DIR/patches"
    # The private sysroot's prebuilt std carries no LLVM bitcode, so the
    # workspace release profile's LTO cannot run for this target.
    export CARGO_PROFILE_RELEASE_LTO=false
    echo "==> Building kandelo-cc for $TRIPLE..."
    cd "$SRC_DIR"
    cargo build --locked --release --target "$TRIPLE" --target-dir "$TARGET_DIR" \
        -p kandelo-cc --bin kandelo-cc
)
OUT_BIN="$TARGET_DIR/$TRIPLE/release/kandelo-cc.wasm"
[ -f "$OUT_BIN" ] || { echo "ERROR: kandelo-cc.wasm not built" >&2; exit 1; }

cd "$REPO_ROOT"
if [ -n "${WASM_POSIX_DEP_WORK_DIR:-}" ] && [ -n "${WASM_POSIX_DEP_OUT_DIR:-}" ]; then
    export WASM_POSIX_INSTALL_LOCAL_MIRROR=0
    export WASM_POSIX_INSTALL_FORK_INSTRUMENTATION=auto
fi
source "$REPO_ROOT/scripts/install-local-binary.sh"
install_local_binary kandelo-cc "$OUT_BIN" kandelo-cc.wasm
