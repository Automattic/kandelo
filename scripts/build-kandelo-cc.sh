#!/usr/bin/env bash
# Build and install the build machine's SDK driver (crates/kandelo-cc) at
# sdk/.build/bin/kandelo-cc, with the input stamp sdk/src/kandelo-cc.sh
# checks. The SDK wrappers run this on demand; run it directly to prebuild.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd -P)"
OUT_DIR="$REPO_ROOT/sdk/.build/bin"
BIN="$OUT_DIR/kandelo-cc"
# Its own target directory: the SDK can be called from inside another cargo
# build (as rustc's linker), which holds the lock on the workspace target dir.
TARGET_DIR="$REPO_ROOT/sdk/.build/kandelo-cc-target"

# shellcheck source=../sdk/src/kandelo-cc-inputs.sh
source "$REPO_ROOT/sdk/src/kandelo-cc-inputs.sh"

if ! command -v cargo >/dev/null 2>&1 || ! command -v rustc >/dev/null 2>&1; then
    echo "build-kandelo-cc: the SDK driver must be built, and cargo/rustc are not on PATH." >&2
    echo "       Run inside scripts/dev-shell.sh." >&2
    exit 1
fi

# Record the inputs before building: a source edited during the build then
# leaves a stamp that no longer matches, and the next run rebuilds.
STAMP="$(kandelo_cc_inputs_stamp "$REPO_ROOT")"
HOST_TARGET="$(rustc -vV | awk '/^host/ {print $2}')"

echo "==> Building the SDK driver (kandelo-cc) for $HOST_TARGET..."
# A package build reaches the SDK with flags meant for its own Rust target;
# none of them apply to the driver.
env -u RUSTFLAGS -u CARGO_ENCODED_RUSTFLAGS -u CARGO_BUILD_RUSTFLAGS \
    -u CARGO_BUILD_TARGET -u CARGO_TARGET_DIR -u CARGO_BUILD_TARGET_DIR \
    -u RUSTC -u RUSTC_WRAPPER -u RUSTC_WORKSPACE_WRAPPER \
    cargo build \
        --manifest-path "$REPO_ROOT/Cargo.toml" \
        --locked \
        --release \
        -p kandelo-cc \
        --target "$HOST_TARGET" \
        --target-dir "$TARGET_DIR"

mkdir -p "$OUT_DIR"
BIN_STAGE="$OUT_DIR/.kandelo-cc.$$.tmp"
STAMP_STAGE="$OUT_DIR/.kandelo-cc.$$.inputs.tmp"
trap 'rm -f "$BIN_STAGE" "$STAMP_STAGE"' EXIT
install -m 0755 "$TARGET_DIR/$HOST_TARGET/release/kandelo-cc" "$BIN_STAGE"
printf '%s\n' "$STAMP" > "$STAMP_STAGE"
mv -f "$BIN_STAGE" "$BIN"
mv -f "$STAMP_STAGE" "$BIN.inputs"
trap - EXIT
echo "==> Installed $BIN"
