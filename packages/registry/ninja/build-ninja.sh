#!/usr/bin/env bash
# Cross-compile Ninja (C++) for Kandelo with upstream's CMake build, the SDK
# toolchain file and the declared libcxx.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$HERE/../../.." && pwd)"
source "$REPO_ROOT/scripts/package-build-roots.sh"
kandelo_package_load_source_metadata "$HERE"
kandelo_package_prepare_build_roots "$HERE" wasm32
WORK="$KANDELO_PACKAGE_WORK_DIR"
SRC="$WORK/ninja-src"
BUILD="$WORK/ninja-build"
source "$REPO_ROOT/sdk/activate.sh"

SYSROOT="${WASM_POSIX_SYSROOT:-$REPO_ROOT/sysroot}"
LIBCXX_DIR="${WASM_POSIX_DEP_LIBCXX_DIR:-}"
if [ -z "$LIBCXX_DIR" ] && [ -z "${WASM_POSIX_DEP_OUT_DIR:-}" ]; then
    HOST_TARGET="$(rustc -vV | awk '/^host/ {print $2}')"
    LIBCXX_DIR="$(cd "$REPO_ROOT" && cargo run -q -p xtask --target "$HOST_TARGET" -- build-deps resolve libcxx --arch wasm32)"
fi
[ -f "$LIBCXX_DIR/lib/libc++.a" ] || { echo "ERROR: libcxx dependency missing" >&2; exit 1; }
export WASM_POSIX_DEP_WORK_DIR="$WORK"
export WASM_POSIX_DEP_LIBCXX_DIR="$LIBCXX_DIR"
SYSROOT="$(kandelo_package_prepare_private_sysroot ninja "$SYSROOT" libcxx)"
export WASM_POSIX_SYSROOT="$SYSROOT"

rm -rf "$SRC" "$BUILD"
kandelo_package_stage_primary_source ninja "$SRC" "$WORK"

# Upstream's own feature checks decide the platform paths: ppoll() is found
# in <poll.h> (USE_PPOLL), and fork() and pipe() enable `ninja -t browse`,
# which runs the guest's python3. Tests are off: they fetch googletest.
echo "==> Configuring ninja..."
cmake -S "$SRC" -B "$BUILD" \
    -DCMAKE_TOOLCHAIN_FILE="$REPO_ROOT/sdk/cmake/kandelo-toolchain.cmake" \
    -DCMAKE_BUILD_TYPE=Release \
    -DCMAKE_CXX_FLAGS_RELEASE="-O2 -DNDEBUG -ffile-prefix-map=$WORK=/usr/src/ninja" \
    -DCMAKE_INTERPROCEDURAL_OPTIMIZATION=OFF \
    -DBUILD_TESTING=OFF \
    -DNINJA_PYTHON=python3 \
    2>&1 | tail -20
grep -q '^HAVE_PPOLL:INTERNAL=1$' "$BUILD/CMakeCache.txt" || {
    echo "ERROR: ninja's CMake did not find ppoll(); it would fall back to pselect()" >&2
    exit 1
}
echo "==> Building ninja..."
cmake --build "$BUILD" --target ninja --parallel 2>&1 | tail -10
NINJA_OUT="$BUILD/ninja.wasm"
[ -f "$NINJA_OUT" ] || NINJA_OUT="$BUILD/ninja"
[ -f "$NINJA_OUT" ] || { echo "ERROR: ninja was not built" >&2; exit 1; }
cp "$NINJA_OUT" "$WORK/ninja.wasm"

cd "$REPO_ROOT"
if [ -n "${WASM_POSIX_DEP_OUT_DIR:-}" ]; then
    export WASM_POSIX_INSTALL_LOCAL_MIRROR=0
    export WASM_POSIX_INSTALL_FORK_INSTRUMENTATION=auto
fi
source "$REPO_ROOT/scripts/install-local-binary.sh"
install_local_binary ninja "$WORK/ninja.wasm" ninja.wasm
