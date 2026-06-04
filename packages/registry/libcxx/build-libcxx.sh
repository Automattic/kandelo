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
#   - kandelo sysroot built (bash build.sh)
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

# Verify host LLVM is at the declared major version. Headers are now
# sourced hermetically from the vendored source build (see the install
# step below), so a mismatch no longer mixes header versions; it only
# means the just-built library is compiled by a different-major clang
# than the vendored source it links against, which can still cause
# codegen/ABI skew. Keep this a warning so Homebrew-LLVM-only boxes can
# still build the pinned source.
if [ -x "$LLVM_CLANG" ]; then
    HOST_LLVM_VERSION="$("$LLVM_CLANG" --version | grep -oE '[0-9]+\.[0-9]+\.[0-9]+' | head -1)"
    HOST_LLVM_MAJOR="${HOST_LLVM_VERSION%%.*}"
    if [ "$HOST_LLVM_MAJOR" != "$LLVM_MAJOR" ]; then
        echo "WARNING: host clang major ($HOST_LLVM_MAJOR) does not match deps.toml version ($LLVM_MAJOR)." >&2
        echo "         The pinned LLVM ${LLVM_MAJOR} source will be compiled by clang ${HOST_LLVM_MAJOR}; codegen/ABI skew is possible." >&2
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
# Modern wasm-EH lowering (commit 9 of the fork-instrument mega-PR).
# Empirical: LLVM 21's `-wasm-use-legacy-eh` default is `true`, so we
# must pass `=false` explicitly to get modern `try_table`/`catch_ref`
# lowering — just dropping the earlier `=true` override leaves the
# toolchain on legacy `try`/`catch`. libcxxabi's
# `__cxa_throw`/`_Unwind_RaiseException` machinery now compiles
# against the modern ABI; consumers linking against this libcxx
# archive must also compile with `-wasm-use-legacy-eh=false` (the
# SDK's `compileFlags` was updated in lock-step).
WASM_C_FLAGS="--target=${WASM_TARGET} -matomics -mbulk-memory -mexception-handling -mllvm -wasm-enable-sjlj -mllvm -wasm-use-legacy-eh=false -fexceptions -fno-trapping-math --sysroot=${SYSROOT} -O2 -DNDEBUG"

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

# Install libc++ headers from the build tree, NOT from the host LLVM.
# The CMake runtimes build stages a complete, version-matched header set
# under $BUILD_DIR/include/c++/v1: the bulk headers from the vendored
# LLVM ${LLVM_MAJOR} source, plus the build-generated __config_site,
# __assertion_handler, module.modulemap, and the libc++abi headers
# (cxxabi.h, __cxxabi_config.h). Sourcing from here makes the artifact
# hermetic: headers, lib/, and __config_site all come from the single
# vendored source we just compiled, so the produced header set cannot
# drift from the produced library.
#
# The previous approach copied headers from the host $LLVM_PREFIX while
# generating __config_site from the vendored source. When the host LLVM
# drifted ahead of the vendored version (e.g. a Homebrew LLVM 22 leaking
# into a non-pure `nix develop` shell), a newer host header
# (__configuration/hardening.h, added in LLVM 22) demanded config macros
# (_LIBCPP_ASSERTION_SEMANTIC_DEFAULT) that the older vendored
# __config_site never emits, breaking every downstream C++ build with a
# cryptic "_LIBCPP_ASSERTION_SEMANTIC_DEFAULT is not defined" error.
STAGED_HEADERS="$BUILD_DIR/include/c++/v1"
if [ ! -f "$STAGED_HEADERS/__config_site" ] || [ ! -f "$STAGED_HEADERS/vector" ]; then
    echo "ERROR: staged header tree incomplete at $STAGED_HEADERS" >&2
    echo "       (expected __config_site + vector from the cxx-headers build target)" >&2
    exit 1
fi
# cp -RL dereferences any symlinks CMake staged into the source tree, so
# the installed copy stays self-contained after $BUILD_DIR is removed.
cp -RL "$STAGED_HEADERS/." "$INSTALL_DIR/include/c++/v1/"
chmod -R u+w "$INSTALL_DIR/include/c++/v1/"
# The .in template is a build input, not a consumer header.
rm -f "$INSTALL_DIR/include/c++/v1/__config_site.in"

# Guard against header/__config_site version mixing: compile a
# representative consumer translation unit against the freshly installed
# header set with the same wasm target. <vector>/<string>/<stdexcept>
# pull in __config, __config_site, the hardening config, the assertion
# handler, and the libc++abi headers, so any inconsistency (a header
# demanding a config macro the __config_site does not define, a missing
# generated header) fails HERE, loudly, at package-build time instead of
# surfacing later in a downstream C++ build. Do not remove: this is the
# check that makes shipping a mixed-version header set impossible.
echo "==> Verifying installed libc++ headers are self-consistent..."
SMOKE_SRC="$BUILD_DIR/.libcxx-smoke.cpp"
SMOKE_LOG="$BUILD_DIR/.libcxx-smoke.log"
cat > "$SMOKE_SRC" <<'EOF'
#include <vector>
#include <string>
#include <stdexcept>
int main() {
    std::vector<int> v;
    v.push_back(1);
    std::string s = "ok";
    if (v.empty()) throw std::runtime_error(s);
    return static_cast<int>(v.size() + s.size());
}
EOF
# shellcheck disable=SC2086 # WASM_C_FLAGS is an intentional word list.
if ! "$LLVM_CLANG" ${WASM_C_FLAGS} \
        -nostdinc++ -isystem "$INSTALL_DIR/include/c++/v1" \
        -c "$SMOKE_SRC" -o "$BUILD_DIR/.libcxx-smoke.o" 2>"$SMOKE_LOG"; then
    echo "ERROR: installed libc++ headers failed a smoke compile." >&2
    echo "       Headers and __config_site are inconsistent (version mix?)." >&2
    sed 's/^/    /' "$SMOKE_LOG" >&2
    exit 1
fi
echo "==> Header smoke compile passed."

echo "==> Done!"
echo "  libc++.a:    $(wc -c < "$INSTALL_DIR/lib/libc++.a" | tr -d ' ') bytes"
echo "  libc++abi.a: $(wc -c < "$INSTALL_DIR/lib/libc++abi.a" | tr -d ' ') bytes"
echo "  headers:     $INSTALL_DIR/include/c++/v1/"
