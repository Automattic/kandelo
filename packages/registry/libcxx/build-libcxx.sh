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
#     WASM_POSIX_DEP_VERSION        # exact LLVM version from flake.nix (e.g. "21.1.7")
#     WASM_POSIX_DEP_TARGET_ARCH    # "wasm32" or "wasm64"
#
# Prerequisites:
#   - scripts/dev-shell.sh / flake.nix, which provides:
#       LLVM_PREFIX, LLVM_VERSION,
#       WASM_POSIX_LLVM_LIBCXX_SOURCE, WASM_POSIX_LLVM_LIBUNWIND_SOURCE
#   - CMake
#   - kandelo sysroot built (bash build.sh)
#
# Output layout:
#   $WASM_POSIX_DEP_OUT_DIR/
#     lib/libc++.a
#     lib/libc++abi.a              ← bundles libunwind contents
#     include/c++/v1/__config_site
#     include/c++/v1/...           ← staged by the Nix-provided libcxx source build

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"
# shellcheck source=/dev/null
source "$REPO_ROOT/sdk/activate.sh"

# --- Inputs from resolver ---
LLVM_VERSION_EXPECTED="${WASM_POSIX_DEP_VERSION:?WASM_POSIX_DEP_VERSION not set (must be invoked via cargo xtask build-deps resolve)}"
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

LLVM_PREFIX="${LLVM_PREFIX:?LLVM_PREFIX not set. Run this build through scripts/dev-shell.sh so flake.nix supplies LLVM.}"
LLVM_VERSION_ACTUAL="${LLVM_VERSION:?LLVM_VERSION not set. Run this build through scripts/dev-shell.sh so flake.nix declares the LLVM version.}"
NIX_LIBCXX_SOURCE="${WASM_POSIX_LLVM_LIBCXX_SOURCE:?WASM_POSIX_LLVM_LIBCXX_SOURCE not set. Run this build through scripts/dev-shell.sh.}"
NIX_LIBUNWIND_SOURCE="${WASM_POSIX_LLVM_LIBUNWIND_SOURCE:?WASM_POSIX_LLVM_LIBUNWIND_SOURCE not set. Run this build through scripts/dev-shell.sh.}"
LLVM_CLANG="$LLVM_PREFIX/bin/clang"
LLVM_AR="$LLVM_PREFIX/bin/llvm-ar"
LLVM_RANLIB="$LLVM_PREFIX/bin/llvm-ranlib"
LLVM_NM="$LLVM_PREFIX/bin/llvm-nm"

if [ "$LLVM_VERSION_ACTUAL" != "$LLVM_VERSION_EXPECTED" ]; then
    echo "ERROR: libcxx package version ($LLVM_VERSION_EXPECTED) does not match flake LLVM_VERSION ($LLVM_VERSION_ACTUAL)." >&2
    echo "       Update packages/registry/libcxx/package.toml and libcxx dependents with the exact Nix LLVM version." >&2
    exit 1
fi

if [ ! -x "$LLVM_CLANG" ]; then
    echo "ERROR: clang not found at $LLVM_CLANG. Run through scripts/dev-shell.sh." >&2
    exit 1
fi

HOST_LLVM_VERSION="$("$LLVM_CLANG" --version | grep -oE '[0-9]+\.[0-9]+\.[0-9]+' | head -1)"
if [ "$HOST_LLVM_VERSION" != "$LLVM_VERSION_EXPECTED" ]; then
    echo "ERROR: clang version ($HOST_LLVM_VERSION) does not match libcxx package version ($LLVM_VERSION_EXPECTED)." >&2
    echo "       Run through scripts/dev-shell.sh so the compiler and libcxx sources come from the same Nix LLVM package." >&2
    exit 1
fi

if [ ! -f "$NIX_LIBCXX_SOURCE/runtimes/CMakeLists.txt" ] ||
        [ ! -d "$NIX_LIBCXX_SOURCE/libcxx" ] ||
        [ ! -d "$NIX_LIBCXX_SOURCE/libcxxabi" ]; then
    echo "ERROR: Nix libcxx source is incomplete at $NIX_LIBCXX_SOURCE" >&2
    echo "       Expected runtimes/, libcxx/, and libcxxabi/ from flake.nix's llvmPackages_21.libcxx.src." >&2
    exit 1
fi

if [ ! -d "$NIX_LIBUNWIND_SOURCE/libunwind" ]; then
    echo "ERROR: Nix libunwind source is incomplete at $NIX_LIBUNWIND_SOURCE" >&2
    echo "       Expected libunwind/ from flake.nix's llvmPackages_21.libunwind.src." >&2
    exit 1
fi

BUILD_DIR="$SCRIPT_DIR/build-${ARCH}"
# Assembled source tree lives OUTSIDE the build dirs so both the default
# (static, non-PIC) build and the position-independent build below can share it
# without one build's `rm -rf` deleting the other's source.
LLVM_SRC_DIR="$SCRIPT_DIR/llvm-source-${ARCH}"

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
    echo "ERROR: cmake not found. Run through scripts/dev-shell.sh." >&2
    exit 1
fi

# --- Build ---
echo "==> Building libc++ and libc++abi for ${ARCH}..."

# Base wasm compile flags — no C++ header paths here; CMake manages its own
# generated headers for the runtimes build.
# Modern wasm-EH lowering (commit 9 of the fork-instrument mega-PR).
# Empirical: this LLVM line's `-wasm-use-legacy-eh` default is `true`, so we
# must pass `=false` explicitly to get modern `try_table`/`catch_ref`
# lowering — just dropping the earlier `=true` override leaves the
# toolchain on legacy `try`/`catch`. libcxxabi's
# `__cxa_throw`/`_Unwind_RaiseException` machinery now compiles
# against the modern ABI; consumers linking against this libcxx
# archive must also compile with `-wasm-use-legacy-eh=false` (the
# SDK's `compileFlags` was updated in lock-step).
WASM_C_FLAGS="--target=${WASM_TARGET} -matomics -mbulk-memory -mexception-handling -mllvm -wasm-enable-sjlj -mllvm -wasm-use-legacy-eh=false -fexceptions -fno-trapping-math --sysroot=${SYSROOT} -O2 -DNDEBUG"

# Start with a fresh source tree so a cache-miss rebuild does not mix old + new
# artifacts. (Each build dir is cleaned by build_libcxx_variant below.)
rm -rf "$LLVM_SRC_DIR"

# Assemble the monorepo-shaped source tree expected by runtimes/CMakeLists.txt
# from exact Nix source derivations. Nix's libcxx source carries runtimes/,
# libcxx/, libcxxabi/, and shared CMake support; libunwind is exposed as a
# smaller separate source derivation. Keep runtimes/ itself as a real directory:
# CMake checks siblings via runtimes/../libunwind, and if runtimes is a symlink
# that `..` resolves inside the Nix libcxx source instead of this overlay tree.
mkdir -p "$LLVM_SRC_DIR"
for entry in cmake libc libcxx libcxxabi llvm third-party; do
    if [ -e "$NIX_LIBCXX_SOURCE/$entry" ]; then
        ln -s "$NIX_LIBCXX_SOURCE/$entry" "$LLVM_SRC_DIR/$entry"
    fi
done
mkdir -p "$LLVM_SRC_DIR/runtimes"
for entry in "$NIX_LIBCXX_SOURCE/runtimes"/*; do
    [ -e "$entry" ] || continue
    ln -s "$entry" "$LLVM_SRC_DIR/runtimes/$(basename "$entry")"
done
ln -s "$NIX_LIBUNWIND_SOURCE/libunwind" "$LLVM_SRC_DIR/libunwind"

NPROC="$(sysctl -n hw.ncpu 2>/dev/null || nproc)"

# Configure + build libc++/libc++abi/libunwind into <build_dir> with the given
# compile-flags string (plus any extra cmake args). Factored so the default
# static archives and the position-independent variant (below) share ONE cmake
# recipe and cannot drift apart.
build_libcxx_variant() {
    local variant_build_dir="$1"; shift
    local variant_c_flags="$1"; shift
    rm -rf "$variant_build_dir"
    mkdir -p "$variant_build_dir"
    ( cd "$variant_build_dir"
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
        -DCMAKE_C_FLAGS="${variant_c_flags}" \
        -DCMAKE_CXX_FLAGS="${variant_c_flags}" \
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
        "$@" \
        2>&1 | tail -20

      echo "==> Compiling (this may take a few minutes)..."
      make -j"$NPROC" cxx cxxabi unwind 2>&1 | tail -10 )
}

echo "==> Building default (static, non-PIC) libc++/libc++abi for ${ARCH}..."
build_libcxx_variant "$BUILD_DIR" "${WASM_C_FLAGS}"

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
# The CMake runtimes build stages a complete, version-matched header set under
# $BUILD_DIR/include/c++/v1: the bulk headers from the Nix-provided libcxx
# source, plus the build-generated __config_site, __assertion_handler,
# module.modulemap, and the libc++abi headers (cxxabi.h, __cxxabi_config.h).
# Sourcing from here makes the artifact hermetic: headers, lib/, and
# __config_site all come from the source version compiled into the libraries.
#
# The previous approach copied headers from the host $LLVM_PREFIX while
# generating __config_site from the package source. When the host LLVM drifted
# ahead of the package version (e.g. a newer host LLVM leaking into a non-pure
# shell), a newer host header
# (__configuration/hardening.h, added in LLVM 22) demanded config macros
# (_LIBCPP_ASSERTION_SEMANTIC_DEFAULT) that the older __config_site never emits,
# breaking every downstream C++ build with a
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

# --- Position-independent variant for wasm side modules ---
# The default archives above are non-PIC, which is correct for the common case:
# static linking into a main wasm module (php.wasm, mariadb, ruby). But a wasm
# SIDE MODULE (built with `-shared --experimental-pic`, e.g. PHP's intl.so, which
# statically absorbs libc++/libc++abi) requires EVERY input object to be
# position-independent, or wasm-ld fails with "relocation R_WASM_MEMORY_ADDR_SLEB
# cannot be used against symbol ...; recompile with -fPIC". Emit a parallel PIC
# pair alongside the defaults. This is purely additive: libc++.a / libc++abi.a
# and the header set above are untouched, so existing static consumers are
# unaffected; only side-module consumers reach for the -pic archives.
echo "==> Building position-independent libc++/libc++abi (for wasm side modules)..."
PIC_BUILD_DIR="$SCRIPT_DIR/build-${ARCH}-pic"
build_libcxx_variant "$PIC_BUILD_DIR" "${WASM_C_FLAGS} -fPIC" -DCMAKE_POSITION_INDEPENDENT_CODE=ON

LIBCXX_PIC_A=$(find "$PIC_BUILD_DIR" -name "libc++.a" -not -path "*/CMakeFiles/*" | head -1)
LIBCXXABI_PIC_A=$(find "$PIC_BUILD_DIR" -name "libc++abi.a" -not -path "*/CMakeFiles/*" | head -1)
if [ -z "$LIBCXX_PIC_A" ] || [ -z "$LIBCXXABI_PIC_A" ]; then
    echo "ERROR: PIC libraries not found under $PIC_BUILD_DIR" >&2
    exit 1
fi
cp "$LIBCXX_PIC_A" "$INSTALL_DIR/lib/libc++-pic.a"
cp "$LIBCXXABI_PIC_A" "$INSTALL_DIR/lib/libc++abi-pic.a"

echo "==> Done!"
echo "  libc++.a:        $(wc -c < "$INSTALL_DIR/lib/libc++.a" | tr -d ' ') bytes"
echo "  libc++abi.a:     $(wc -c < "$INSTALL_DIR/lib/libc++abi.a" | tr -d ' ') bytes"
echo "  libc++-pic.a:    $(wc -c < "$INSTALL_DIR/lib/libc++-pic.a" | tr -d ' ') bytes"
echo "  libc++abi-pic.a: $(wc -c < "$INSTALL_DIR/lib/libc++abi-pic.a" | tr -d ' ') bytes"
echo "  headers:         $INSTALL_DIR/include/c++/v1/"
