#!/usr/bin/env bash
set -euo pipefail

# Build GNU cflow for wasm32-posix-kernel.
#
# cflow can run the C preprocessor through popen(), so the binary is
# fork-instrumented when it needs it. --disable-debug: cflow's configure
# otherwise defaults to a debug build that drops -O2 and adds -ggdb, which
# also records build-host paths in the binary's DWARF sections.
#
# Output: $KANDELO_PACKAGE_WORK_DIR/bin/cflow.wasm

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"
# shellcheck source=/dev/null
source "$REPO_ROOT/scripts/package-build-roots.sh"
kandelo_package_prepare_build_roots "$SCRIPT_DIR" wasm32
WORK_DIR="$KANDELO_PACKAGE_WORK_DIR"
SRC_DIR="$WORK_DIR/cflow-src"
BIN_DIR="$WORK_DIR/bin"
SYSROOT="$REPO_ROOT/sysroot"
VERSION="${WASM_POSIX_DEP_VERSION:-1.8}"
SOURCE_URL="${WASM_POSIX_DEP_SOURCE_URL:-https://ftpmirror.gnu.org/cflow/cflow-${VERSION}.tar.xz}"
SOURCE_SHA256="${WASM_POSIX_DEP_SOURCE_SHA256:-a5830a708a587ebbf3b475b585935f89c33fc8fbd057af7d817d517aceaa7afa}"
VERIFIED_SOURCE_DIR="${WASM_POSIX_DEP_SOURCE_DIR:-}"
SOURCE_MARKER="$SRC_DIR/.kandelo-cflow-source"

# A resolver/Formula caller owns the declared work and output roots. Keep the
# reviewed checkout read-only and suppress the developer-only local mirror.
if [ -n "${WASM_POSIX_DEP_WORK_DIR:-}" ] && [ -n "${WASM_POSIX_DEP_OUT_DIR:-}" ]; then
    export WASM_POSIX_INSTALL_LOCAL_MIRROR=0
    export WASM_POSIX_INSTALL_FORK_INSTRUMENTATION=auto
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
    echo "==> Staging verified cflow $VERSION source..."
    kandelo_package_stage_verified_source cflow "$SRC_DIR" \
        "$VERIFIED_SOURCE_DIR" "$SOURCE_URL" "$SOURCE_SHA256" "$WORK_DIR"
    printf '%s\n' "$expected_source_marker" >"$SOURCE_MARKER"
fi

cd "$SRC_DIR"
mkdir -p "$BIN_DIR"

# --- Configure ---
if [ ! -f Makefile ]; then
    echo "==> Configuring cflow for wasm32..."
    wasm32posix-configure --disable-nls --disable-debug CFLAGS="-O2" 2>&1 | tail -30
fi

# --- Build ---
echo "==> Building cflow..."
make -j"$(sysctl -n hw.ncpu 2>/dev/null || nproc)" 2>&1 | tail -30
cp src/cflow "$BIN_DIR/cflow.wasm"
ls -lh "$BIN_DIR/cflow.wasm"

source "$REPO_ROOT/scripts/install-local-binary.sh"
install_local_binary cflow "$BIN_DIR/cflow.wasm"
