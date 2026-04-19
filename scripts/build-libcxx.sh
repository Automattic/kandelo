#!/usr/bin/env bash
set -euo pipefail

# Build libc++ and libc++abi for wasm32 or wasm64 from LLVM source.
#
# Produces real libc++.a and libc++abi.a archives with C++ exception support,
# replacing the empty stubs created by the MariaDB build script.
#
# Prerequisites:
#   - Homebrew LLVM 21.x (brew install llvm)
#   - CMake (brew install cmake)
#   - wasm-posix-kernel sysroot built (bash build.sh)
#
# Usage:
#   bash scripts/build-libcxx.sh              # default: wasm32 → sysroot/
#   bash scripts/build-libcxx.sh --arch wasm64  # wasm64 → sysroot64/

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

# Parse arch arg
ARCH="wasm32"
while [ $# -gt 0 ]; do
    case "$1" in
        --arch) ARCH="$2"; shift 2 ;;
        *) echo "Unknown argument: $1" >&2; exit 1 ;;
    esac
done

case "$ARCH" in
    wasm32)
        SYSROOT="$REPO_ROOT/sysroot"
        WASM_TARGET="wasm32-unknown-unknown"
        SIZEOF_VOID_P=4
        ;;
    wasm64)
        SYSROOT="$REPO_ROOT/sysroot64"
        WASM_TARGET="wasm64-unknown-unknown"
        SIZEOF_VOID_P=8
        ;;
    *)
        echo "Error: unsupported arch '$ARCH'. Use wasm32 or wasm64." >&2
        exit 1
        ;;
esac

LLVM_PREFIX="$(brew --prefix llvm 2>/dev/null || echo /opt/homebrew/opt/llvm)"
LLVM_CLANG="$LLVM_PREFIX/bin/clang"
LLVM_AR="$LLVM_PREFIX/bin/llvm-ar"
LLVM_RANLIB="$LLVM_PREFIX/bin/llvm-ranlib"
LLVM_NM="$LLVM_PREFIX/bin/llvm-nm"

# Get LLVM major version to match source
LLVM_VERSION="$("$LLVM_CLANG" --version | grep -oE '[0-9]+\.[0-9]+\.[0-9]+' | head -1)"
LLVM_MAJOR="${LLVM_VERSION%%.*}"

LLVM_SRC_DIR="$REPO_ROOT/.build-cache/llvm-project-${LLVM_MAJOR}"
BUILD_DIR="$REPO_ROOT/.build-cache/libcxx-${ARCH}-build"

# --- Check if already built ---
if [ -f "$SYSROOT/lib/libc++.a" ]; then
    SIZE=$(wc -c < "$SYSROOT/lib/libc++.a" | tr -d ' ')
    if [ "$SIZE" -gt 1000 ]; then
        echo "libc++.a already built (${SIZE} bytes). Skipping."
        echo "To force rebuild: rm $SYSROOT/lib/libc++.a $SYSROOT/lib/libc++abi.a"
        exit 0
    fi
fi

# --- Verify prerequisites ---
if [ ! -f "$SYSROOT/lib/libc.a" ]; then
    echo "ERROR: sysroot not found. Run: bash build.sh" >&2
    exit 1
fi

if ! command -v cmake &>/dev/null; then
    echo "ERROR: cmake not found. Install: brew install cmake" >&2
    exit 1
fi

# --- Clone LLVM source (sparse, runtimes only) ---
if [ ! -d "$LLVM_SRC_DIR/runtimes/CMakeLists.txt" ] 2>/dev/null; then
    echo "==> Cloning LLVM ${LLVM_MAJOR}.x source (runtimes only)..."
    mkdir -p "$LLVM_SRC_DIR"
    rm -rf "$LLVM_SRC_DIR"

    git clone --depth=1 --branch "release/${LLVM_MAJOR}.x" \
        --filter=blob:none --sparse \
        https://github.com/llvm/llvm-project.git "$LLVM_SRC_DIR"

    cd "$LLVM_SRC_DIR"
    git sparse-checkout set libcxx libcxxabi runtimes cmake llvm/cmake llvm/utils/llvm-lit libc
    cd "$REPO_ROOT"
    echo "==> LLVM source ready."
fi

# --- Build ---
echo "==> Building libc++ and libc++abi for ${ARCH}..."

# Base wasm compile flags — no C++ header paths here; CMake manages its own
# generated headers for the runtimes build.
WASM_C_FLAGS="--target=${WASM_TARGET} -matomics -mbulk-memory -mexception-handling -mllvm -wasm-enable-sjlj -mllvm -wasm-use-legacy-eh=true -fexceptions -fno-trapping-math --sysroot=${SYSROOT} -O2 -DNDEBUG"

rm -rf "$BUILD_DIR"
mkdir -p "$BUILD_DIR"
cd "$BUILD_DIR"

cmake -G "Unix Makefiles" -S "$LLVM_SRC_DIR/runtimes" \
    -DLLVM_ENABLE_RUNTIMES="libcxx;libcxxabi" \
    -DCMAKE_SYSTEM_NAME=Generic \
    -DCMAKE_SYSTEM_PROCESSOR="${ARCH}" \
    -DCMAKE_C_COMPILER="$LLVM_CLANG" \
    -DCMAKE_CXX_COMPILER="$LLVM_CLANG" \
    -DCMAKE_AR="$LLVM_AR" \
    -DCMAKE_RANLIB="$LLVM_RANLIB" \
    -DCMAKE_NM="$LLVM_NM" \
    -DCMAKE_C_COMPILER_TARGET="${WASM_TARGET}" \
    -DCMAKE_CXX_COMPILER_TARGET="${WASM_TARGET}" \
    -DCMAKE_C_FLAGS="${WASM_C_FLAGS}" \
    -DCMAKE_CXX_FLAGS="${WASM_C_FLAGS}" \
    -DCMAKE_SYSROOT="${SYSROOT}" \
    -DCMAKE_TRY_COMPILE_TARGET_TYPE=STATIC_LIBRARY \
    \
    -DLIBCXX_ENABLE_SHARED=OFF \
    -DLIBCXX_ENABLE_STATIC=ON \
    -DLIBCXX_ENABLE_EXCEPTIONS=ON \
    -DLIBCXX_ENABLE_RTTI=ON \
    -DLIBCXX_HAS_MUSL_LIBC=ON \
    -DLIBCXX_HAS_PTHREAD_API=ON \
    -DLIBCXX_CXX_ABI=libcxxabi \
    -DLIBCXX_INCLUDE_BENCHMARKS=OFF \
    -DLIBCXX_INCLUDE_TESTS=OFF \
    -DLIBCXX_ENABLE_FILESYSTEM=ON \
    -DLIBCXX_ENABLE_MONOTONIC_CLOCK=ON \
    -DLIBCXX_ENABLE_RANDOM_DEVICE=OFF \
    -DLIBCXX_ENABLE_LOCALIZATION=ON \
    -DLIBCXX_ENABLE_WIDE_CHARACTERS=ON \
    -DLIBCXX_ENABLE_NEW_DELETE_DEFINITIONS=ON \
    \
    -DLIBCXXABI_ENABLE_SHARED=OFF \
    -DLIBCXXABI_ENABLE_STATIC=ON \
    -DLIBCXXABI_ENABLE_EXCEPTIONS=ON \
    -DLIBCXXABI_USE_LLVM_UNWINDER=OFF \
    -DLIBCXXABI_ENABLE_THREADS=ON \
    -DLIBCXXABI_HAS_PTHREAD_API=ON \
    -DLIBCXXABI_INCLUDE_TESTS=OFF \
    \
    -DCMAKE_SIZEOF_VOID_P="${SIZEOF_VOID_P}" \
    2>&1 | tail -20

echo "==> Compiling (this may take a few minutes)..."
NPROC="$(sysctl -n hw.ncpu 2>/dev/null || nproc)"
make -j"$NPROC" cxx cxxabi 2>&1 | tail -10

# --- Install ---
echo "==> Installing to sysroot..."

# Back up stubs if they exist
for lib in libc++.a libc++abi.a; do
    if [ -f "$SYSROOT/lib/$lib" ]; then
        mv "$SYSROOT/lib/$lib" "$SYSROOT/lib/${lib}.stub-backup"
    fi
done

# Find and install built archives
LIBCXX_A=$(find "$BUILD_DIR" -name "libc++.a" -not -path "*/CMakeFiles/*" | head -1)
LIBCXXABI_A=$(find "$BUILD_DIR" -name "libc++abi.a" -not -path "*/CMakeFiles/*" | head -1)

if [ -z "$LIBCXX_A" ] || [ -z "$LIBCXXABI_A" ]; then
    echo "ERROR: Built libraries not found" >&2
    # Restore stubs
    for lib in libc++.a libc++abi.a; do
        if [ -f "$SYSROOT/lib/${lib}.stub-backup" ]; then
            mv "$SYSROOT/lib/${lib}.stub-backup" "$SYSROOT/lib/$lib"
        fi
    done
    exit 1
fi

cp "$LIBCXX_A" "$SYSROOT/lib/libc++.a"
cp "$LIBCXXABI_A" "$SYSROOT/lib/libc++abi.a"

# Also install the generated __config_site so sysroot headers match the built library
GENERATED_CONFIG_SITE="$BUILD_DIR/include/c++/v1/__config_site"
if [ -f "$GENERATED_CONFIG_SITE" ]; then
    cp "$GENERATED_CONFIG_SITE" "$SYSROOT/include/c++/v1/__config_site"
fi

# Clean up backups
rm -f "$SYSROOT/lib/libc++.a.stub-backup" "$SYSROOT/lib/libc++abi.a.stub-backup"

echo "==> Done!"
echo "  libc++.a:    $(wc -c < "$SYSROOT/lib/libc++.a" | tr -d ' ') bytes"
echo "  libc++abi.a: $(wc -c < "$SYSROOT/lib/libc++abi.a" | tr -d ' ') bytes"
