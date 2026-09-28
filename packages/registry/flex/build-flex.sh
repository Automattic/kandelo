#!/usr/bin/env bash
set -euo pipefail

# Build flex for wasm32-posix-kernel.
#
# --disable-bootstrap builds flex from the scanner the release tarball ships
# instead of regenerating it with a freshly built flex, which a cross build
# cannot run. flex runs m4 at runtime; configure would compile in the *build
# host's* m4 path, so it is told the target's: /usr/bin/m4 in the root
# filesystem. flex forks to run m4 as a filter, so the binary is
# fork-instrumented.
#
# Output: $KANDELO_PACKAGE_WORK_DIR/bin/flex.wasm

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"
# shellcheck source=/dev/null
source "$REPO_ROOT/scripts/package-build-roots.sh"
kandelo_package_prepare_build_roots "$SCRIPT_DIR" wasm32
WORK_DIR="$KANDELO_PACKAGE_WORK_DIR"
SRC_DIR="$WORK_DIR/flex-src"
BIN_DIR="$WORK_DIR/bin"
SYSROOT="$REPO_ROOT/sysroot"
VERSION="${WASM_POSIX_DEP_VERSION:-2.6.4}"
SOURCE_URL="${WASM_POSIX_DEP_SOURCE_URL:-https://github.com/westes/flex/releases/download/v${VERSION}/flex-${VERSION}.tar.gz}"
SOURCE_SHA256="${WASM_POSIX_DEP_SOURCE_SHA256:-e87aae032bf07c26f85ac0ed3250998c37621d95f8bd748b31f15b33c45ee995}"
VERIFIED_SOURCE_DIR="${WASM_POSIX_DEP_SOURCE_DIR:-}"
SOURCE_MARKER="$SRC_DIR/.kandelo-flex-source"

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
    echo "==> Staging verified flex $VERSION source..."
    kandelo_package_stage_verified_source flex "$SRC_DIR" \
        "$VERIFIED_SOURCE_DIR" "$SOURCE_URL" "$SOURCE_SHA256" "$WORK_DIR"
    printf '%s\n' "$expected_source_marker" >"$SOURCE_MARKER"
fi

cd "$SRC_DIR"
mkdir -p "$BIN_DIR"

# --- Configure ---
if [ ! -f Makefile ]; then
    echo "==> Configuring flex for wasm32..."
    ac_cv_path_M4=/usr/bin/m4 wasm32posix-configure \
        --disable-bootstrap --disable-nls --disable-shared \
        CFLAGS="-O2" 2>&1 | tail -30
fi

# --- Build ---
echo "==> Building flex..."
make -j"$(sysctl -n hw.ncpu 2>/dev/null || nproc)" -C src flex 2>&1 | tail -30
cp src/flex "$BIN_DIR/flex.wasm"
ls -lh "$BIN_DIR/flex.wasm"

source "$REPO_ROOT/scripts/install-local-binary.sh"
install_local_binary flex "$BIN_DIR/flex.wasm"
