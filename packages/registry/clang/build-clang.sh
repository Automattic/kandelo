#!/usr/bin/env bash
set -euo pipefail

# Cross-build clang, wasm-ld, and llvm-{ar,ranlib,nm} to wasm32 for Kandelo.
# Preserves the proven LLVM CMake configuration from the exploration branch;
# adapts the host contract to the new local build system.

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"

# shellcheck source=/dev/null
source "$REPO_ROOT/sdk/activate.sh"
# shellcheck source=/dev/null
source "$REPO_ROOT/scripts/package-build-roots.sh"
kandelo_package_prepare_build_roots "$SCRIPT_DIR/clang-work" wasm32

WORK_DIR="$KANDELO_PACKAGE_WORK_DIR"
LLVM_MAJOR=21
ARCH="${WASM_POSIX_DEP_TARGET_ARCH:-wasm32}"
SYSROOT="${WASM_POSIX_SYSROOT:-$REPO_ROOT/sysroot}"
LIBCXX_DIR="${WASM_POSIX_DEP_LIBCXX_DIR:-}"
SOURCE_URL="${WASM_POSIX_DEP_SOURCE_URL:-https://github.com/llvm/llvm-project/releases/download/llvmorg-21.1.7/llvm-project-21.1.7.src.tar.xz}"
SOURCE_SHA256="${WASM_POSIX_DEP_SOURCE_SHA256:-e5b65fd79c95c343bb584127114cb2d252306c1ada1e057899b6aacdd445899e}"
VERIFIED_SOURCE_DIR="${WASM_POSIX_DEP_SOURCE_DIR:-}"

LLVM_SRC_DIR="$WORK_DIR/llvm-project-${LLVM_MAJOR}"
HOST_BUILD_DIR="$WORK_DIR/build-host-tablegen-${LLVM_MAJOR}"
BUILD_DIR="$WORK_DIR/build-wasm32"

if [ -n "${WASM_POSIX_DEP_WORK_DIR:-}" ] && [ -n "${WASM_POSIX_DEP_OUT_DIR:-}" ]; then
  export WASM_POSIX_INSTALL_LOCAL_MIRROR=0
  # These toolchain binaries do not fork: clang uses its integrated cc1
  # (in-process) and the guest `cc` wrapper drives clang then wasm-ld as
  # separate processes. Fork instrumentation is therefore inapplicable;
  # declare it disabled rather than run the instrument pass on a ~44 MB
  # module. (Running the clang driver directly to link would fork/exec the
  # linker and is an unsupported path until an in-guest fork-instrument
  # exists — a documented boundary, not something this build papers over.)
  export WASM_POSIX_INSTALL_FORK_INSTRUMENTATION=disabled
fi

[ "$ARCH" = wasm32 ] || { echo "ERROR: clang supports wasm32 only" >&2; exit 1; }
[ -f "$SYSROOT/lib/libc.a" ] || { echo "ERROR: sysroot missing; run scripts/build-musl.sh" >&2; exit 1; }
for _t in wasm32posix-cc wasm32posix-c++ wasm32posix-ar wasm32posix-ranlib wasm32posix-nm; do
  command -v "$_t" >/dev/null || { echo "ERROR: SDK wrapper $_t not on PATH; source sdk/activate.sh" >&2; exit 1; }
done

# libc++ from the resolved dependency; fall back to an in-sysroot copy.
if [ -z "$LIBCXX_DIR" ] && [ -f "$SYSROOT/lib/libc++.a" ]; then LIBCXX_DIR="$SYSROOT"; fi
[ -f "$LIBCXX_DIR/lib/libc++.a" ] || { echo "ERROR: libcxx dependency missing" >&2; exit 1; }

# --- Merge libc++ headers/libs into a private, writable sysroot ---
# The base $SYSROOT (musl only) has no C++ headers; LLVM/clang's cmake
# configure needs <atomic>, <vector>, etc. from the resolved libcxx
# dependency (CheckAtomic's `#include <atomic>` try-compile fails
# otherwise). Same private-sysroot pattern as
# packages/registry/icu/build-icu.sh.
# Make SYSROOT private in BOTH modes so the libc++ merge below never
# mutates the shared platform sysroot ($REPO_ROOT/sysroot).
if [ -n "${WASM_POSIX_DEP_WORK_DIR:-}" ] && [ -n "${WASM_POSIX_DEP_OUT_DIR:-}" ]; then
  export WASM_POSIX_DEP_LIBCXX_DIR="$LIBCXX_DIR"
  SYSROOT="$(kandelo_package_prepare_private_sysroot clang "$SYSROOT" libcxx)"
else
  # Direct (non-resolver) mode: seed a throwaway private sysroot from the
  # shared one and merge libc++ there. The shared sysroot is never written.
  PRIV_SYSROOT="$WORK_DIR/private-sysroot"
  rm -rf "$PRIV_SYSROOT"
  mkdir -p "$PRIV_SYSROOT"
  cp -a "$SYSROOT/." "$PRIV_SYSROOT/"
  SYSROOT="$PRIV_SYSROOT"
fi
export WASM_POSIX_SYSROOT="$SYSROOT"
# $SYSROOT is now private in both modes. In resolver mode
# kandelo_package_prepare_private_sysroot already overlaid libcxx; re-linking
# here is harmless and keeps the direct-mode path self-contained.
echo "==> Linking libcxx into private sysroot ($LIBCXX_DIR)..."
mkdir -p "$SYSROOT/lib" "$SYSROOT/include/c++"
ln -sf  "$LIBCXX_DIR/lib/libc++.a"    "$SYSROOT/lib/libc++.a"
ln -sf  "$LIBCXX_DIR/lib/libc++abi.a" "$SYSROOT/lib/libc++abi.a"
rm -rf  "$SYSROOT/include/c++/v1"
ln -sfn "$LIBCXX_DIR/include/c++/v1"  "$SYSROOT/include/c++/v1"

CC_TOOL="$(command -v wasm32posix-cc)"
CXX_TOOL="$(command -v wasm32posix-c++)"
AR_TOOL="$(command -v wasm32posix-ar)"
RANLIB_TOOL="$(command -v wasm32posix-ranlib)"
NM_TOOL="$(command -v wasm32posix-nm)"

# --- Stage verified LLVM source into the writable work dir ---
if [ ! -f "$LLVM_SRC_DIR/llvm/CMakeLists.txt" ]; then
  echo "==> Staging verified LLVM ${LLVM_MAJOR} source..."
  kandelo_package_stage_verified_source clang "$LLVM_SRC_DIR" \
    "$VERIFIED_SOURCE_DIR" "$SOURCE_URL" "$SOURCE_SHA256" "$WORK_DIR"

  echo "==> Applying Kandelo wasm patches..."
  for p in "$SCRIPT_DIR"/patches/*.patch; do
    patch -p1 -d "$LLVM_SRC_DIR" < "$p"
  done
fi

# --- Host tablegen: prefer dev-shell LLVM, else build from source ---
find_host_tool() {
  local name="$1" c
  for c in "${WASM_POSIX_LLVM_DIR:-}/$name" "$HOST_BUILD_DIR/bin/$name" "$(command -v "$name" 2>/dev/null || true)"; do
    [ -n "$c" ] && [ -x "$c" ] && { printf '%s\n' "$c"; return 0; }
  done
  return 1
}
LLVM_TABLEGEN_BIN="$(find_host_tool llvm-tblgen || true)"
CLANG_TABLEGEN_BIN="$(find_host_tool clang-tblgen || true)"
if [ -z "$LLVM_TABLEGEN_BIN" ] || [ -z "$CLANG_TABLEGEN_BIN" ]; then
  echo "==> Building host llvm-tblgen and clang-tblgen..."
  cmake -G "Unix Makefiles" -S "$LLVM_SRC_DIR/llvm" -B "$HOST_BUILD_DIR" \
    -DCMAKE_BUILD_TYPE=Release -DLLVM_ENABLE_PROJECTS="clang" \
    -DLLVM_TARGETS_TO_BUILD="WebAssembly" -DLLVM_INCLUDE_TESTS=OFF \
    -DLLVM_INCLUDE_BENCHMARKS=OFF -DLLVM_INCLUDE_EXAMPLES=OFF \
    -DLLVM_ENABLE_ZLIB=OFF -DLLVM_ENABLE_ZSTD=OFF -DLLVM_ENABLE_LIBXML2=OFF \
    -DLLVM_ENABLE_TERMINFO=OFF -DLLVM_ENABLE_LIBEDIT=OFF 2>&1 | tail -20
  cmake --build "$HOST_BUILD_DIR" --target llvm-tblgen clang-tblgen \
    -j"$(sysctl -n hw.ncpu 2>/dev/null || nproc)" 2>&1 | tail -20
  LLVM_TABLEGEN_BIN="$HOST_BUILD_DIR/bin/llvm-tblgen"
  CLANG_TABLEGEN_BIN="$HOST_BUILD_DIR/bin/clang-tblgen"
fi

# --- Kandelo compat shim: musl omits the BSD <machine/endian.h> that
# LLVM's ADT/bit.h includes (LLVM_ON_UNIX selects the BSD endian path).
# Provide a shim mapping it to musl's <endian.h>, scoped to this build via
# -isystem; this does not mutate the sysroot, so it is inert for every
# other package. The exploration branch instead added this header to the
# musl overlay; scoping it here keeps the platform sysroot untouched.
COMPAT_INC="$WORK_DIR/compat-include"
mkdir -p "$COMPAT_INC/machine"
cat > "$COMPAT_INC/machine/endian.h" <<'ENDIAN_EOF'
#ifndef _MACHINE_ENDIAN_H
#define _MACHINE_ENDIAN_H
#include <endian.h>
#endif
ENDIAN_EOF

# --- Configure the wasm32 cross build (verbatim from the proven recipe) ---
COMMON_FLAGS=(-O1 -g0 -fno-exceptions -fno-rtti -isystem "$COMPAT_INC" -DCLANG_BUILD_STATIC -DLLVM_BUILD_STATIC -DLLVM_ON_UNIX=1)
LINK_FLAGS=("$LIBCXX_DIR/lib/libc++.a" "$LIBCXX_DIR/lib/libc++abi.a")

cmake -G "Unix Makefiles" -S "$LLVM_SRC_DIR/llvm" -B "$BUILD_DIR" \
  -DCMAKE_BUILD_TYPE=MinSizeRel -DCMAKE_SYSTEM_NAME=Generic \
  -DCMAKE_SYSTEM_PROCESSOR=wasm32 \
  -DCMAKE_C_COMPILER="$CC_TOOL" -DCMAKE_CXX_COMPILER="$CXX_TOOL" \
  -DCMAKE_AR="$AR_TOOL" -DCMAKE_RANLIB="$RANLIB_TOOL" -DCMAKE_NM="$NM_TOOL" \
  -DCMAKE_TRY_COMPILE_TARGET_TYPE=STATIC_LIBRARY \
  -DCMAKE_C_FLAGS="${COMMON_FLAGS[*]}" -DCMAKE_CXX_FLAGS="${COMMON_FLAGS[*]}" \
  -DCMAKE_EXE_LINKER_FLAGS="${LINK_FLAGS[*]}" \
  -DCMAKE_FIND_ROOT_PATH_MODE_PROGRAM=NEVER \
  -DCMAKE_FIND_ROOT_PATH_MODE_LIBRARY=ONLY \
  -DCMAKE_FIND_ROOT_PATH_MODE_INCLUDE=ONLY \
  -DCMAKE_FIND_ROOT_PATH_MODE_PACKAGE=ONLY \
  -DLLVM_TABLEGEN="$LLVM_TABLEGEN_BIN" -DCLANG_TABLEGEN="$CLANG_TABLEGEN_BIN" \
  -DLLVM_ENABLE_PROJECTS="clang;lld" -DLLVM_TARGETS_TO_BUILD="WebAssembly" \
  -DLLVM_DEFAULT_TARGET_TRIPLE=wasm32-unknown-unknown \
  -DLLVM_HOST_TRIPLE=wasm32-unknown-unknown \
  -DLLVM_BUILD_TOOLS=ON -DLLVM_INCLUDE_TOOLS=ON -DLLVM_INCLUDE_UTILS=OFF \
  -DLLVM_INCLUDE_TESTS=OFF -DLLVM_INCLUDE_BENCHMARKS=OFF -DLLVM_INCLUDE_EXAMPLES=OFF \
  -DLLVM_ENABLE_ASSERTIONS=OFF -DLLVM_ENABLE_BACKTRACES=OFF -DLLVM_ENABLE_DIA_SDK=OFF \
  -DLLVM_ENABLE_EH=OFF -DLLVM_ENABLE_RTTI=OFF -DLLVM_ENABLE_THREADS=OFF \
  -DLLVM_ENABLE_PIC=OFF -DLLVM_ENABLE_ZLIB=OFF -DLLVM_ENABLE_ZSTD=OFF \
  -DLLVM_ENABLE_LIBXML2=OFF -DLLVM_ENABLE_TERMINFO=OFF -DLLVM_ENABLE_LIBEDIT=OFF \
  -DLLVM_ENABLE_LIBCXX=ON -DLLVM_BUILD_LLVM_DYLIB=OFF -DLLVM_LINK_LLVM_DYLIB=OFF \
  -DBUILD_SHARED_LIBS=OFF -DCLANG_ENABLE_ARCMT=OFF \
  -DCLANG_ENABLE_STATIC_ANALYZER=OFF -DCLANG_ENABLE_PLUGIN_SUPPORT=OFF \
  2>&1 | tail -40

echo "==> Building clang tools..."
# Default to -j1: the final link of the ~44 MB clang.wasm binary is
# memory-hungry, and parallel LLVM links at higher -j can OOM the host.
# Override with KANDELO_CLANG_BUILD_JOBS on machines with enough memory.
cmake --build "$BUILD_DIR" --target clang lld llvm-ar llvm-ranlib llvm-nm \
  -j"${KANDELO_CLANG_BUILD_JOBS:-1}" 2>&1 | tail -40

# --- Install the five declared outputs ---
# LLVM emits several tools as symlinks (clang -> clang-21, wasm-ld -> lld,
# llvm-ranlib -> llvm-ar). install_local_binary requires regular
# non-symlink files, so dereference each into a staging dir with `cp -L`
# first (llvm-ar/llvm-nm are already regular; cp -L copies them intact).
STAGE_DIR="$WORK_DIR/stage-bin"
mkdir -p "$STAGE_DIR"
cp -L "$BUILD_DIR/bin/clang"       "$STAGE_DIR/clang.wasm"
cp -L "$BUILD_DIR/bin/wasm-ld"     "$STAGE_DIR/wasm-ld.wasm"
cp -L "$BUILD_DIR/bin/llvm-ar"     "$STAGE_DIR/llvm-ar.wasm"
cp -L "$BUILD_DIR/bin/llvm-ranlib" "$STAGE_DIR/llvm-ranlib.wasm"
cp -L "$BUILD_DIR/bin/llvm-nm"     "$STAGE_DIR/llvm-nm.wasm"

source "$REPO_ROOT/scripts/install-local-binary.sh"
install_local_binary clang "$STAGE_DIR/clang.wasm"       clang.wasm
install_local_binary clang "$STAGE_DIR/wasm-ld.wasm"     wasm-ld.wasm
install_local_binary clang "$STAGE_DIR/llvm-ar.wasm"     llvm-ar.wasm
install_local_binary clang "$STAGE_DIR/llvm-ranlib.wasm" llvm-ranlib.wasm
install_local_binary clang "$STAGE_DIR/llvm-nm.wasm"     llvm-nm.wasm

echo "==> clang package build complete."
