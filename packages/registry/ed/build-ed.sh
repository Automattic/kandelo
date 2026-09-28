#!/usr/bin/env bash
set -euo pipefail

# Build GNU ed for wasm32-posix-kernel.
#
# GNU ed publishes only lzip (.tar.lz) archives; the resolver and
# kandelo_package_stage_verified_source both decode lzip. ed's configure is
# hand-written (not autoconf) and takes the compiler on its command line.
# ed runs shell commands with popen() for `!` and `r !`/`w !`, so the binary
# is fork-instrumented by install_local_binary.
#
# Output: $KANDELO_PACKAGE_WORK_DIR/bin/ed.wasm

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"
# shellcheck source=/dev/null
source "$REPO_ROOT/scripts/package-build-roots.sh"
kandelo_package_prepare_build_roots "$SCRIPT_DIR" wasm32
WORK_DIR="$KANDELO_PACKAGE_WORK_DIR"
SRC_DIR="$WORK_DIR/ed-src"
BIN_DIR="$WORK_DIR/bin"
SYSROOT="$REPO_ROOT/sysroot"
VERSION="${WASM_POSIX_DEP_VERSION:-1.22.6}"
SOURCE_URL="${WASM_POSIX_DEP_SOURCE_URL:-https://ftpmirror.gnu.org/ed/ed-${VERSION}.tar.lz}"
SOURCE_SHA256="${WASM_POSIX_DEP_SOURCE_SHA256:-3f33b22135219c39c3c695f7b7171c2567d3e2a17c798c0a90607320cbb268f2}"
VERIFIED_SOURCE_DIR="${WASM_POSIX_DEP_SOURCE_DIR:-}"
SOURCE_MARKER="$SRC_DIR/.kandelo-ed-source"

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
    echo "==> Staging verified ed $VERSION source..."
    kandelo_package_stage_verified_source ed "$SRC_DIR" \
        "$VERIFIED_SOURCE_DIR" "$SOURCE_URL" "$SOURCE_SHA256" "$WORK_DIR"
    printf '%s\n' "$expected_source_marker" >"$SOURCE_MARKER"
fi

cd "$SRC_DIR"
mkdir -p "$BIN_DIR"

# --- Configure ---
if [ ! -f Makefile ]; then
    echo "==> Configuring ed for wasm32..."
    ./configure --prefix=/usr CC=wasm32posix-cc CFLAGS="-O2" 2>&1 | tail -30
fi

# --- Build ---
echo "==> Building ed..."
make -j"$(sysctl -n hw.ncpu 2>/dev/null || nproc)" 2>&1 | tail -30
cp ed "$BIN_DIR/ed.wasm"
ls -lh "$BIN_DIR/ed.wasm"

source "$REPO_ROOT/scripts/install-local-binary.sh"
install_local_binary ed "$BIN_DIR/ed.wasm"
