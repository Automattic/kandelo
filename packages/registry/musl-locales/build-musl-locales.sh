#!/usr/bin/env bash
set -euo pipefail

# Build musl-locales' locale(1) for wasm32-posix-kernel.
#
# Only the `locale` CMake target is built. The po/ subdirectories compile
# translation catalogs with the build host's msgfmt, which the dev shell
# does not carry, and they are data rather than the program. The toolchain
# file follows docs/sdk-guide.md ("CMake Projects").
#
# CMAKE_POLICY_VERSION_MINIMUM: the project declares cmake_minimum_required
# 2.8, which CMake 4 refuses; this is CMake's documented way to build such a
# project with 3.5-era policies (Alpine builds it with CMake 3).
#
# Output: $KANDELO_PACKAGE_WORK_DIR/bin/locale.wasm

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"
# shellcheck source=/dev/null
source "$REPO_ROOT/scripts/package-build-roots.sh"
kandelo_package_prepare_build_roots "$SCRIPT_DIR" wasm32
WORK_DIR="$KANDELO_PACKAGE_WORK_DIR"
SRC_DIR="$WORK_DIR/musl-locales-src"
BIN_DIR="$WORK_DIR/bin"
SYSROOT="$REPO_ROOT/sysroot"
VERSION="${WASM_POSIX_DEP_VERSION:-0.1.0}"
SOURCE_URL="${WASM_POSIX_DEP_SOURCE_URL:-https://git.adelielinux.org/adelie/musl-locales/-/archive/${VERSION}/musl-locales-${VERSION}.tar.bz2}"
SOURCE_SHA256="${WASM_POSIX_DEP_SOURCE_SHA256:-92462fba981f05ecbd6cf4816645cb3b91011383a0a6b71a6b0b2718c18d017b}"
VERIFIED_SOURCE_DIR="${WASM_POSIX_DEP_SOURCE_DIR:-}"
SOURCE_MARKER="$SRC_DIR/.kandelo-musl-locales-source"

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
    echo "==> Staging verified musl-locales $VERSION source..."
    kandelo_package_stage_verified_source musl-locales "$SRC_DIR" \
        "$VERIFIED_SOURCE_DIR" "$SOURCE_URL" "$SOURCE_SHA256" "$WORK_DIR"
    printf '%s\n' "$expected_source_marker" >"$SOURCE_MARKER"
fi

cd "$SRC_DIR"
mkdir -p "$BIN_DIR"

# --- Configure ---
TOOLCHAIN="$WORK_DIR/wasm32-posix-toolchain.cmake"
cat >"$TOOLCHAIN" <<'CMAKE'
set(CMAKE_SYSTEM_NAME Generic)
set(CMAKE_SYSTEM_PROCESSOR wasm32)
set(CMAKE_C_COMPILER wasm32posix-cc)
set(CMAKE_AR wasm32posix-ar)
set(CMAKE_RANLIB wasm32posix-ranlib)
set(CMAKE_FIND_ROOT_PATH_MODE_PROGRAM NEVER)
set(CMAKE_FIND_ROOT_PATH_MODE_LIBRARY ONLY)
set(CMAKE_FIND_ROOT_PATH_MODE_INCLUDE ONLY)
CMAKE
if [ ! -f build/CMakeCache.txt ]; then
    echo "==> Configuring musl-locales for wasm32..."
    cmake -S . -B build -DCMAKE_TOOLCHAIN_FILE="$TOOLCHAIN" \
        -DCMAKE_FIND_ROOT_PATH="$SYSROOT" -DCMAKE_BUILD_TYPE=Release \
        -DCMAKE_INSTALL_PREFIX=/usr -DLOCALE_PROFILE=OFF \
        -DCMAKE_POLICY_VERSION_MINIMUM=3.5 2>&1 | tail -30
fi

# --- Build ---
echo "==> Building locale..."
cmake --build build --target locale 2>&1 | tail -30
cp build/locale "$BIN_DIR/locale.wasm"
ls -lh "$BIN_DIR/locale.wasm"

source "$REPO_ROOT/scripts/install-local-binary.sh"
install_local_binary musl-locales "$BIN_DIR/locale.wasm"
