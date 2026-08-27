#!/usr/bin/env bash
set -euo pipefail

# Cross-build clang, wasm-ld, and llvm-{ar,ranlib,nm} to wasm32 for Kandelo.
# Build in resolver-owned roots using the worktree SDK and declared libcxx.

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"

# shellcheck source=/dev/null
source "$REPO_ROOT/sdk/activate.sh"
# shellcheck source=/dev/null
source "$REPO_ROOT/scripts/package-build-roots.sh"
kandelo_package_load_source_metadata "$SCRIPT_DIR"
kandelo_package_prepare_build_roots "$SCRIPT_DIR/clang-work" wasm32

WORK_DIR="$KANDELO_PACKAGE_WORK_DIR"
LLVM_MAJOR="${WASM_POSIX_DEP_VERSION%%.*}"
ARCH="${WASM_POSIX_DEP_TARGET_ARCH:-wasm32}"
SYSROOT="${WASM_POSIX_SYSROOT:-$REPO_ROOT/sysroot}"
LIBCXX_DIR="${WASM_POSIX_DEP_LIBCXX_DIR:-}"

LLVM_SRC_DIR="$WORK_DIR/llvm-project-${LLVM_MAJOR}"
HOST_BUILD_DIR="$WORK_DIR/build-host-tablegen-${LLVM_MAJOR}"
BUILD_DIR="$WORK_DIR/build-wasm32"

if [ -n "${WASM_POSIX_DEP_WORK_DIR:-}" ] && [ -n "${WASM_POSIX_DEP_OUT_DIR:-}" ]; then
  export WASM_POSIX_INSTALL_LOCAL_MIRROR=0
  # LLVM links fork-using process support even when the guest wrapper uses
  # integrated cc1 and launches the linker separately. Runtime admission
  # requires the normal continuation contract for every fork import.
  export WASM_POSIX_INSTALL_FORK_INSTRUMENTATION=auto
fi

[ "$ARCH" = wasm32 ] || { echo "ERROR: clang supports wasm32 only" >&2; exit 1; }
[ -f "$SYSROOT/lib/libc.a" ] || { echo "ERROR: sysroot missing; run scripts/build-musl.sh" >&2; exit 1; }
for _t in wasm32posix-cc wasm32posix-c++ wasm32posix-ar wasm32posix-ranlib wasm32posix-nm; do
  command -v "$_t" >/dev/null || { echo "ERROR: SDK wrapper $_t not on PATH; source sdk/activate.sh" >&2; exit 1; }
done

# Resolver builds require the declared dependency; standalone builds resolve
# that same package instead of using an untracked copy in the shared sysroot.
if [ -z "$LIBCXX_DIR" ] && [ -z "${WASM_POSIX_DEP_OUT_DIR:-}" ]; then
  HOST_TARGET="$(rustc -vV | awk '/^host/ {print $2}')"
  LIBCXX_DIR="$(cd "$REPO_ROOT" && cargo run -q -p xtask --target "$HOST_TARGET" -- build-deps resolve libcxx --arch wasm32)"
fi
[ -f "$LIBCXX_DIR/lib/libc++.a" ] || { echo "ERROR: libcxx dependency missing" >&2; exit 1; }

# Overlay the declared libcxx dependency into a private regular-file sysroot.
# The shared SDK and sealed dependency trees remain inputs in both modes.
export WASM_POSIX_DEP_WORK_DIR="$WORK_DIR"
export WASM_POSIX_DEP_LIBCXX_DIR="$LIBCXX_DIR"
SYSROOT="$(kandelo_package_prepare_private_sysroot clang "$SYSROOT" libcxx)"
export WASM_POSIX_SYSROOT="$SYSROOT"

CC_TOOL="$(command -v wasm32posix-cc)"
CXX_TOOL="$(command -v wasm32posix-c++)"
AR_TOOL="$(command -v wasm32posix-ar)"
RANLIB_TOOL="$(command -v wasm32posix-ranlib)"
NM_TOOL="$(command -v wasm32posix-nm)"

# --- Stage verified LLVM source into the writable work dir ---
echo "==> Staging verified LLVM ${WASM_POSIX_DEP_VERSION} source..."
kandelo_package_stage_primary_source clang "$LLVM_SRC_DIR" "$WORK_DIR"

echo "==> Applying LLVM portability and wasm-only driver patches..."
for p in "$SCRIPT_DIR"/patches/*.patch; do
  patch -p1 -d "$LLVM_SRC_DIR" < "$p"
done

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
    -DLLVM_ENABLE_TERMINFO=OFF -DLLVM_ENABLE_LIBEDIT=OFF
  cmake --build "$HOST_BUILD_DIR" --target llvm-tblgen clang-tblgen \
    -j"$(sysctl -n hw.ncpu 2>/dev/null || nproc)"
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

# --- Configure for Kandelo POSIX on wasm32 ---
COMMON_FLAGS=("-ffile-prefix-map=$REPO_ROOT=/kandelo" "-ffile-prefix-map=$WORK_DIR=/kandelo-build/clang" -O1 -g0 -fno-exceptions -fno-rtti -isystem "$COMPAT_INC" -DCLANG_BUILD_STATIC -DLLVM_BUILD_STATIC)
# Keep each large host wasm-ld link within the same resource bound as the
# default serial build, even when compilation jobs are raised explicitly.
LINK_FLAGS=(-Wl,--threads=1 "$LIBCXX_DIR/lib/libc++.a" "$LIBCXX_DIR/lib/libc++abi.a")

cmake -G "Unix Makefiles" -S "$LLVM_SRC_DIR/llvm" -B "$BUILD_DIR" \
  -DCMAKE_BUILD_TYPE=MinSizeRel -DCMAKE_SYSTEM_NAME=Kandelo \
  -DCMAKE_MODULE_PATH="$REPO_ROOT/sdk/cmake" \
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
  -DCLANG_ENABLE_STATIC_ANALYZER=OFF -DCLANG_ENABLE_PLUGIN_SUPPORT=OFF

echo "==> Building clang tools..."
# Default to -j1: the final link of the ~44 MB clang.wasm binary is
# memory-hungry, and parallel LLVM links at higher -j can OOM the host.
# Override with KANDELO_CLANG_BUILD_JOBS on machines with enough memory.
cmake --build "$BUILD_DIR" --target clang lld llvm-ar llvm-ranlib llvm-nm \
  -j"${KANDELO_CLANG_BUILD_JOBS:-1}"

# --- Install the five declared outputs ---
# The Kandelo CMake platform supplies the .wasm executable suffix. LLVM
# emits version/driver aliases as symlinks. install_local_binary requires regular
# non-symlink files, so dereference each into a staging dir with `cp -L`
# first (llvm-ar/llvm-nm are already regular; cp -L copies them intact).
STAGE_DIR="$WORK_DIR/stage-bin"
mkdir -p "$STAGE_DIR"
cp -L "$BUILD_DIR/bin/clang.wasm"       "$STAGE_DIR/clang.wasm"
cp -L "$BUILD_DIR/bin/wasm-ld.wasm"     "$STAGE_DIR/wasm-ld.wasm"
cp -L "$BUILD_DIR/bin/llvm-ar.wasm"     "$STAGE_DIR/llvm-ar.wasm"
cp -L "$BUILD_DIR/bin/llvm-ranlib.wasm" "$STAGE_DIR/llvm-ranlib.wasm"
cp -L "$BUILD_DIR/bin/llvm-nm.wasm"     "$STAGE_DIR/llvm-nm.wasm"

# Binaryen's recursive StackIR writer overflows macOS's small native worker
# stacks on these instrumented LLVM functions. One core runs its full O2
# post-pass on the main thread, without disabling optimization or validation.
export BINARYEN_CORES=1
source "$REPO_ROOT/scripts/install-local-binary.sh"
install_local_binary clang "$STAGE_DIR/clang.wasm"       clang.wasm
install_local_binary clang "$STAGE_DIR/wasm-ld.wasm"     wasm-ld.wasm
install_local_binary clang "$STAGE_DIR/llvm-ar.wasm"     llvm-ar.wasm
install_local_binary clang "$STAGE_DIR/llvm-ranlib.wasm" llvm-ranlib.wasm
install_local_binary clang "$STAGE_DIR/llvm-nm.wasm"     llvm-nm.wasm

echo "==> clang package build complete."
