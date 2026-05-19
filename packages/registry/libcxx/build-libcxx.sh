#!/usr/bin/env bash
set -euo pipefail

# Build libc++, libc++abi, and libunwind for wasm32 or wasm64 from LLVM source.
#
# As of revision 2, LLVM libunwind is built alongside libcxx + libcxxabi
# and statically linked into libc++abi.a (via the three-flag combo:
# LIBCXXABI_USE_LLVM_UNWINDER + LIBCXXABI_ENABLE_STATIC_UNWINDER +
# LIBCXXABI_STATICALLY_LINK_UNWINDER_IN_STATIC_LIBRARY). Consumers can
# therefore link `-lc++ -lc++abi` and have `_Unwind_*` symbols resolved
# without naming `-lunwind` separately. C++ throw/catch propagates
# end-to-end through the wasm exception-handling proposal.
#
# Honors the dep-resolver build-script contract (see
# docs/package-management.md). When invoked via
# `cargo xtask build-deps resolve libcxx`, these env vars are set by
# the resolver:
#
#     WASM_POSIX_DEP_OUT_DIR        # where to install (lib/, include/c++/v1/)
#     WASM_POSIX_DEP_VERSION        # LLVM major version (e.g. "21")
#     WASM_POSIX_DEP_TARGET_ARCH    # "wasm32" or "wasm64"
#
# Prerequisites:
#   - Homebrew LLVM (brew install llvm) at the version declared in deps.toml
#   - CMake (brew install cmake)
#   - wasm-posix-kernel sysroot built (bash build.sh)
#
# Output layout:
#   $WASM_POSIX_DEP_OUT_DIR/
#     lib/libc++.a
#     lib/libc++abi.a              ← bundles libunwind contents
#     include/c++/v1/__config_site
#     include/c++/v1/...           ← copied from $LLVM_PREFIX/include/c++/v1

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"
# shellcheck source=/dev/null
source "$REPO_ROOT/sdk/activate.sh"

# --- Inputs from resolver ---
LLVM_MAJOR="${WASM_POSIX_DEP_VERSION:?WASM_POSIX_DEP_VERSION not set (must be invoked via cargo xtask build-deps resolve)}"
INSTALL_DIR="${WASM_POSIX_DEP_OUT_DIR:?WASM_POSIX_DEP_OUT_DIR not set (must be invoked via cargo xtask build-deps resolve)}"
ARCH="${WASM_POSIX_DEP_TARGET_ARCH:-wasm32}"

case "$ARCH" in
    wasm32)
        SYSROOT="${WASM_POSIX_SYSROOT:-$REPO_ROOT/sysroot}"
        WASM_TARGET="wasm32-unknown-unknown"
        SIZEOF_VOID_P=4
        ;;
    wasm64)
        SYSROOT="${WASM_POSIX_SYSROOT:-$REPO_ROOT/sysroot64}"
        WASM_TARGET="wasm64-unknown-unknown"
        SIZEOF_VOID_P=8
        ;;
    *)
        echo "Error: unsupported arch '$ARCH'. Use wasm32 or wasm64." >&2
        exit 1
        ;;
esac

LLVM_PREFIX="${LLVM_PREFIX:-$(brew --prefix llvm 2>/dev/null || echo /opt/homebrew/opt/llvm)}"
LLVM_CLANG="$LLVM_PREFIX/bin/clang"
LLVM_AR="$LLVM_PREFIX/bin/llvm-ar"
LLVM_RANLIB="$LLVM_PREFIX/bin/llvm-ranlib"
LLVM_NM="$LLVM_PREFIX/bin/llvm-nm"

# Verify host LLVM is at the declared major version.
if [ -x "$LLVM_CLANG" ]; then
    HOST_LLVM_VERSION="$("$LLVM_CLANG" --version | grep -oE '[0-9]+\.[0-9]+\.[0-9]+' | head -1)"
    HOST_LLVM_MAJOR="${HOST_LLVM_VERSION%%.*}"
    if [ "$HOST_LLVM_MAJOR" != "$LLVM_MAJOR" ]; then
        echo "WARNING: host LLVM major ($HOST_LLVM_MAJOR) does not match deps.toml version ($LLVM_MAJOR)." >&2
        echo "         Build may still work but headers come from host LLVM." >&2
    fi
else
    echo "ERROR: host clang not found at $LLVM_CLANG. Install with: brew install llvm" >&2
    exit 1
fi

LLVM_SRC_DIR="$SCRIPT_DIR/llvm-project-${LLVM_MAJOR}"
BUILD_DIR="$SCRIPT_DIR/build-${ARCH}"

# --- Verify prerequisites ---
if [ ! -f "$SYSROOT/lib/libc.a" ]; then
    if [ "$ARCH" = "wasm64" ]; then
        echo "ERROR: sysroot64 not found at $SYSROOT. Run: bash scripts/build-musl.sh --arch wasm64posix" >&2
    else
        echo "ERROR: sysroot not found at $SYSROOT. Run: bash build.sh" >&2
    fi
    exit 1
fi

if ! command -v cmake &>/dev/null; then
    echo "ERROR: cmake not found. Install: brew install cmake" >&2
    exit 1
fi

# --- Clone LLVM source (sparse, runtimes only) ---
if [ ! -f "$LLVM_SRC_DIR/runtimes/CMakeLists.txt" ]; then
    echo "==> Cloning LLVM ${LLVM_MAJOR}.x source (sparse: libcxx + libcxxabi + libunwind)..."
    rm -rf "$LLVM_SRC_DIR"
    mkdir -p "$LLVM_SRC_DIR"

    git clone --depth=1 --branch "release/${LLVM_MAJOR}.x" \
        --filter=blob:none --sparse \
        https://github.com/llvm/llvm-project.git "$LLVM_SRC_DIR"

    (cd "$LLVM_SRC_DIR" && \
        git sparse-checkout set libcxx libcxxabi libunwind runtimes cmake llvm/cmake llvm/utils/llvm-lit libc)
    echo "==> LLVM source ready."
fi

# --- Build ---
echo "==> Building libc++ and libc++abi for ${ARCH}..."

# Base wasm compile flags — no C++ header paths here; CMake manages its own
# generated headers for the runtimes build.
WASM_C_FLAGS="--target=${WASM_TARGET} -matomics -mbulk-memory -mexception-handling -mllvm -wasm-enable-sjlj -mllvm -wasm-use-legacy-eh=true -fexceptions -fno-trapping-math --sysroot=${SYSROOT} -O2 -DNDEBUG"

# Always start with a fresh build tree so a cache-miss rebuild does
# not mix old + new cmake artifacts.
rm -rf "$BUILD_DIR"
mkdir -p "$BUILD_DIR"
cd "$BUILD_DIR"

cmake -G "Unix Makefiles" -S "$LLVM_SRC_DIR/runtimes" \
    -DLLVM_ENABLE_RUNTIMES="libcxx;libcxxabi;libunwind" \
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
    -DLIBCXXABI_USE_LLVM_UNWINDER=ON \
    -DLIBCXXABI_ENABLE_STATIC_UNWINDER=ON \
    -DLIBCXXABI_STATICALLY_LINK_UNWINDER_IN_STATIC_LIBRARY=ON \
    -DLIBCXXABI_ENABLE_THREADS=ON \
    -DLIBCXXABI_HAS_PTHREAD_API=ON \
    -DLIBCXXABI_INCLUDE_TESTS=OFF \
    \
    -DLIBUNWIND_ENABLE_SHARED=OFF \
    -DLIBUNWIND_ENABLE_STATIC=ON \
    -DLIBUNWIND_ENABLE_THREADS=ON \
    -DLIBUNWIND_USE_COMPILER_RT=OFF \
    -DLIBUNWIND_INCLUDE_TESTS=OFF \
    -DLIBUNWIND_HIDE_SYMBOLS=ON \
    \
    -DCMAKE_SIZEOF_VOID_P="${SIZEOF_VOID_P}" \
    2>&1 | tail -20

echo "==> Compiling (this may take a few minutes)..."
NPROC="$(sysctl -n hw.ncpu 2>/dev/null || nproc)"
make -j"$NPROC" cxx cxxabi unwind 2>&1 | tail -10

# --- Install into the resolver's OUT_DIR ---
echo "==> Installing to $INSTALL_DIR..."
mkdir -p "$INSTALL_DIR/lib" "$INSTALL_DIR/include/c++/v1"

# Find and install built archives.
LIBCXX_A=$(find "$BUILD_DIR" -name "libc++.a" -not -path "*/CMakeFiles/*" | head -1)
LIBCXXABI_A=$(find "$BUILD_DIR" -name "libc++abi.a" -not -path "*/CMakeFiles/*" | head -1)

if [ -z "$LIBCXX_A" ] || [ -z "$LIBCXXABI_A" ]; then
    echo "ERROR: Built libraries not found under $BUILD_DIR" >&2
    exit 1
fi

cp "$LIBCXX_A" "$INSTALL_DIR/lib/libc++.a"
cp "$LIBCXXABI_A" "$INSTALL_DIR/lib/libc++abi.a"

# Copy libc++ headers from host LLVM. We continue to source headers from
# the host LLVM at build time (matching version with the binary we just
# produced); migrating headers into an upstream tarball is a future
# cleanup tracked in the design doc.
#
# Header path differs by distribution:
#   - Homebrew LLVM:  $LLVM_PREFIX/include/c++/v1/
#   - Nix LLVM:       $LLVM_PREFIX/share/libc++/v1/
# Try both in order; first one with __config (or iostream) wins.
LLVM_CXX_HEADERS=""
for cand in "$LLVM_PREFIX/include/c++/v1" "$LLVM_PREFIX/share/libc++/v1"; do
    if [ -f "$cand/__config" ] || [ -f "$cand/iostream" ]; then
        LLVM_CXX_HEADERS="$cand"
        break
    fi
done
if [ -z "$LLVM_CXX_HEADERS" ]; then
    echo "ERROR: libc++ headers not found under $LLVM_PREFIX (tried include/c++/v1 and share/libc++/v1)" >&2
    exit 1
fi
# cp -L dereferences symlinks (Nix's symlinkJoin tree contains read-only
# symlinks; later writes to __config_site fail with EACCES otherwise).
cp -RL "$LLVM_CXX_HEADERS/." "$INSTALL_DIR/include/c++/v1/"
chmod -R u+w "$INSTALL_DIR/include/c++/v1/"

# Override __config_site with the build-generated copy so the headers
# match the just-built libc++.a (musl libc + pthread thread API +
# serial PSTL backend, never libdispatch).
GENERATED_CONFIG_SITE="$BUILD_DIR/include/c++/v1/__config_site"
if [ -f "$GENERATED_CONFIG_SITE" ]; then
    cp "$GENERATED_CONFIG_SITE" "$INSTALL_DIR/include/c++/v1/__config_site"
fi

echo "==> Done!"
echo "  libc++.a:    $(wc -c < "$INSTALL_DIR/lib/libc++.a" | tr -d ' ') bytes"
echo "  libc++abi.a: $(wc -c < "$INSTALL_DIR/lib/libc++abi.a" | tr -d ' ') bytes"
echo "  headers:     $INSTALL_DIR/include/c++/v1/"
