#!/usr/bin/env bash
set -euo pipefail

# Build Berkeley yacc for wasm32-posix-kernel.
#
# Output: $KANDELO_PACKAGE_WORK_DIR/bin/yacc.wasm

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"
# shellcheck source=/dev/null
source "$REPO_ROOT/scripts/package-build-roots.sh"
kandelo_package_prepare_build_roots "$SCRIPT_DIR" wasm32
WORK_DIR="$KANDELO_PACKAGE_WORK_DIR"
SRC_DIR="$WORK_DIR/byacc-src"
BIN_DIR="$WORK_DIR/bin"
SYSROOT="$REPO_ROOT/sysroot"
VERSION="${WASM_POSIX_DEP_VERSION:-20260126}"
SOURCE_URL="${WASM_POSIX_DEP_SOURCE_URL:-https://invisible-mirror.net/archives/byacc/byacc-${VERSION}.tgz}"
SOURCE_SHA256="${WASM_POSIX_DEP_SOURCE_SHA256:-b618c5fb44c2f5f048843db90f7d1b24f78f47b07913c8c7ba8c942d3eb24b00}"
VERIFIED_SOURCE_DIR="${WASM_POSIX_DEP_SOURCE_DIR:-}"
SOURCE_MARKER="$SRC_DIR/.kandelo-byacc-source"

# A resolver/Formula caller owns the declared work and output roots. Keep the
# reviewed checkout read-only and suppress the developer-only local mirror.
if [ -n "${WASM_POSIX_DEP_WORK_DIR:-}" ] && [ -n "${WASM_POSIX_DEP_OUT_DIR:-}" ]; then
    export WASM_POSIX_INSTALL_LOCAL_MIRROR=0
    export WASM_POSIX_INSTALL_FORK_INSTRUMENTATION=disabled
fi

# Keep direct and resolver-driven builds pinned to this worktree's SDK.
# shellcheck source=/dev/null
source "$REPO_ROOT/sdk/activate.sh"

if ! command -v wasm32posix-cc &>/dev/null; then
    echo "ERROR: wasm32posix-cc not found. Run through scripts/dev-shell.sh." >&2
    exit 1
fi

if [ ! -f "$SYSROOT/lib/libc.a" ]; then
    echo "ERROR: sysroot not found. Run: bash build.sh && bash scripts/build-musl.sh" >&2
    exit 1
fi

export WASM_POSIX_SYSROOT="$SYSROOT"

# --- Stage verified source ---
expected_source_marker="$(printf '%s\n%s\n%s' \
    "$VERSION" "$SOURCE_URL" "$SOURCE_SHA256")"
if [ -d "$SRC_DIR" ] && \
   [ "$(cat "$SOURCE_MARKER" 2>/dev/null || true)" != "$expected_source_marker" ]; then
    rm -rf "$SRC_DIR" "$BIN_DIR"
fi
if [ ! -d "$SRC_DIR" ]; then
    echo "==> Staging verified byacc $VERSION source..."
    kandelo_package_stage_verified_source byacc "$SRC_DIR" \
        "$VERIFIED_SOURCE_DIR" "$SOURCE_URL" "$SOURCE_SHA256" "$WORK_DIR"
    printf '%s\n' "$expected_source_marker" >"$SOURCE_MARKER"
fi

cd "$SRC_DIR"
mkdir -p "$BIN_DIR"

# --- Configure ---
if [ ! -f makefile ]; then
    echo "==> Configuring byacc for wasm32..."
    wasm32posix-configure CFLAGS="-O2" 2>&1 | tail -30
fi

# --- Build ---
echo "==> Building byacc..."
make -j"$(sysctl -n hw.ncpu 2>/dev/null || nproc)" 2>&1 | tail -30
cp yacc "$BIN_DIR/yacc.wasm"
ls -lh "$BIN_DIR/yacc.wasm"

source "$REPO_ROOT/scripts/install-local-binary.sh"
install_local_binary byacc "$BIN_DIR/yacc.wasm"
