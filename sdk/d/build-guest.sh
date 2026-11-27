#!/usr/bin/env bash
set -euo pipefail

if [[ $# != 3 ]]; then
    printf 'Usage: %s <D SDK directory> <wasm32 libcxx package directory> <output-directory>\n' "$0" >&2
    exit 2
fi

sdk_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$sdk_dir/../.." && pwd)"
sdk="$(cd "$1" && pwd)"
libcxx="$(cd "$2" && pwd)"
mkdir -p "$3"
work="$(mktemp -d "$(cd "$3" && pwd)/kandelo-guest-d.XXXXXXXX")"
printf 'Guest D build directory: %s\n' "$work"

cd "$REPO_ROOT"
source sdk/activate.sh
source scripts/package-build-roots.sh
source scripts/abi-contract-stamp.sh
: "${KANDELO_LLVM_DEV:?Run this script from scripts/dev-shell.sh}"
: "${KANDELO_D_LLVM_PREFIX:?Set this to the optional d-llvm flake package}"
llvm_prefix="$(cd "$KANDELO_D_LLVM_PREFIX" && pwd)"
export WASM_POSIX_DEP_WORK_DIR="$work" WASM_POSIX_DEP_LIBCXX_DIR="$libcxx"
export WASM_POSIX_SYSROOT
WASM_POSIX_SYSROOT="$(kandelo_package_prepare_private_sysroot guest-d "$REPO_ROOT/sysroot" libcxx)"

jobs="${KANDELO_D_BUILD_JOBS:-4}"
llvm_version=22.1.8
if [[ "$("$llvm_prefix/bin/llvm-config" --version)" != "$llvm_version" ]]; then
    printf 'The D guest compiler requires LLVM %s TableGen.\n' "$llvm_version" >&2
    exit 2
fi
llvm_digest=922f1817a0df7b1489272d18134ee0087a8b068828f87ac63b9861b1a9965888
llvm_release="llvm-project-$llvm_version.src"
archive="$work/$llvm_release.tar.xz"
curl --fail --location --silent --show-error \
    "https://github.com/llvm/llvm-project/releases/download/llvmorg-$llvm_version/$llvm_release.tar.xz" \
    -o "$archive"
printf '%s  %s\n' "$llvm_digest" "$archive" | sha256sum --check
llvm_source="$work/llvm-source"
mkdir "$llvm_source"
tar -xJf "$archive" -C "$llvm_source" --strip-components=1 \
    "$llvm_release/llvm" "$llvm_release/cmake" "$llvm_release/third-party"
patch --batch --fuzz=0 -p1 -d "$llvm_source" \
    < packages/registry/clang/patches/0004-wasm-path-statvfs.patch
# LLVM launches the linker and other tools through posix_spawn only. Its fork
# fallback lets a child that fails to redirect its streams return into the
# compiler, so the fork instrumenter must keep every caller resumable in a
# fork child: nearly all of ldc2. Kandelo's posix_spawn creates the child
# without fork, so ldc2 has no fork path through LLVM at all.
patch --batch --fuzz=0 -p1 -d "$llvm_source" \
    < "$sdk_dir/llvm-$llvm_version-kandelo-spawn.patch"

# Wasm tail calls let a call in tail position reuse the caller's engine
# frame. The DMD frontend recurses deeply, and WebKit gives a first call far
# less Wasm stack than Chromium or Node (docs/browser-support.md, "Engine
# stack depth"). The guest DUB compile passed on a first WebKit run only
# with tail calls. Kandelo's Wasm exception handling already needs newer
# engines than tail calls do, so this raises no browser requirement.
tail_calls=-mtail-call

cross=(
    -DCMAKE_BUILD_TYPE=MinSizeRel -DCMAKE_SYSTEM_NAME=Kandelo
    "-DCMAKE_MODULE_PATH=$REPO_ROOT/sdk/cmake" -DCMAKE_SYSTEM_PROCESSOR=wasm32
    -DCMAKE_TRY_COMPILE_TARGET_TYPE=STATIC_LIBRARY
    "-DCMAKE_C_COMPILER=$(command -v wasm32posix-cc)"
    "-DCMAKE_CXX_COMPILER=$(command -v wasm32posix-c++)"
    "-DCMAKE_AR=$(command -v wasm32posix-ar)"
    "-DCMAKE_RANLIB=$(command -v wasm32posix-ranlib)"
)
llvm_build="$work/llvm-build"
cmake -G Ninja -S "$llvm_source/llvm" -B "$llvm_build" "${cross[@]}" \
    "-DCMAKE_C_FLAGS=-O1 -g0 $tail_calls -include endian.h" \
    "-DCMAKE_CXX_FLAGS=-O1 -g0 $tail_calls -fno-exceptions -fno-rtti -include endian.h" \
    -DCMAKE_FIND_ROOT_PATH_MODE_PROGRAM=NEVER -DCMAKE_FIND_ROOT_PATH_MODE_LIBRARY=ONLY \
    -DCMAKE_FIND_ROOT_PATH_MODE_INCLUDE=ONLY -DLLVM_TARGETS_TO_BUILD=WebAssembly \
    "-DLLVM_TABLEGEN=$llvm_prefix/bin/llvm-tblgen" \
    -DLLVM_HOST_TRIPLE=wasm32-unknown-kandelo-musl \
    -DLLVM_DEFAULT_TARGET_TRIPLE=wasm32-unknown-kandelo-musl \
    -DLLVM_INCLUDE_TESTS=OFF -DLLVM_INCLUDE_BENCHMARKS=OFF \
    -DLLVM_INCLUDE_EXAMPLES=OFF -DLLVM_INCLUDE_UTILS=OFF \
    -DLLVM_ENABLE_ZLIB=OFF -DLLVM_ENABLE_ZSTD=OFF -DLLVM_ENABLE_LIBXML2=OFF \
    -DLLVM_ENABLE_TERMINFO=OFF -DLLVM_ENABLE_LIBEDIT=OFF -DLLVM_ENABLE_BACKTRACES=OFF \
    -DLLVM_ENABLE_ASSERTIONS=OFF -DLLVM_ENABLE_THREADS=ON \
    -DLLVM_ENABLE_EH=OFF -DLLVM_ENABLE_RTTI=OFF \
    -DLLVM_BUILD_LLVM_DYLIB=OFF -DLLVM_LINK_LLVM_DYLIB=OFF -DBUILD_SHARED_LIBS=OFF
cmake --build "$llvm_build" --target llvm-libraries --parallel "$jobs"

if [[ ! -x "$sdk/ldc-build/bin/ldmd2" ]]; then
    cmake --build "$sdk/ldc-build" --target ldmd2 --parallel "$jobs"
fi
ldc_source="$work/ldc-source"
cp -R "$sdk/release-src" "$ldc_source"
patch --batch --fuzz=0 -p1 -d "$ldc_source" < "$sdk_dir/ldc-1.43.0-guest.patch"
runtime="$sdk/release-src/runtime"
libraries="$sdk/runtime-build/lib"
flags="-conf= --mtriple=wasm32-unknown-kandelo-musl --mattr=+atomics,+bulk-memory,+mutable-globals,+tail-call"
flags+=" --wasm-enable-eh --wasm-use-legacy-eh=false -gcc=wasm32posix-cc"
flags+=" -I='$runtime/druntime/src' -I='$runtime/phobos' -I='$sdk/ldc-build/import'"
ldc_build="$work/ldc-build"
# -O0 at the link (after MinSizeRel's -Os) stops clang from scheduling its
# post-link wasm-opt. That pass inlines: in ldc2 it merged about 81,000
# functions into 37,500, and the fewer but larger frames overflowed
# WebKit's first-tier Wasm stack again. The size optimization runs below,
# with inlining disabled.
cmake -G Ninja -S "$ldc_source" -B "$ldc_build" "${cross[@]}" \
    "-DCMAKE_CXX_FLAGS=$tail_calls -fno-rtti -fno-exceptions -include endian.h" \
    '-DCMAKE_EXE_LINKER_FLAGS=-Wl,--threads=1 -pthread -O0' \
    "-DLLVM_DIR=$llvm_build/lib/cmake/llvm" \
    "-DD_COMPILER=$sdk/ldc-build/bin/ldmd2" "-DD_COMPILER_FLAGS=$flags" \
    "-DD_LINKER_ARGS=$libraries/libphobos2-ldc.a;$libraries/libdruntime-ldc.a;$libraries/libkandelo-continuation.a;-lm" \
    -DLDC_BUILD_RUNTIME=OFF -DLDC_ENABLE_PLUGINS=OFF -DLDC_INSTALL_LTOPLUGIN=OFF
cmake --build "$ldc_build" --target ldc2 --parallel "$jobs"

stage="$work/usr"
mkdir -p "$stage"/{bin,libexec,lib/d,include/d}
# ldc2 has no fork path once LLVM spawns its tools and DRuntime has no
# fork-based marking, so the instrumenter leaves it unchanged and skips
# its own wasm-opt. Optimize for size here without inlining, for the stack
# depth reason above.
# [RUNTIME-WORKAROUND: BINARYEN-133-CONSTRAINT-ANALYSIS] -Os schedules
# Binaryen 133's constraint-analysis pass, which aborts on some LLVM 23 code
# and measured no worthwhile win; Kandelo skips it everywhere until a
# re-measured decision (docs/future-improvements.md) says otherwise.
scripts/run-wasm-fork-instrument.sh "$ldc_build/bin/ldc2.wasm" -o "$work/ldc2.instrumented.wasm"
wasm-opt "$work/ldc2.instrumented.wasm" --no-inline='*' -Os \
    --skip-pass=constraint-analysis --strip-debug --strip-producers \
    -o "$stage/bin/ldc2"
abi_contract_stamp_prepare
abi_contract_stamp "$stage/bin/ldc2"
install -m 0644 "$sdk_dir/ldc2.conf" "$stage/bin/ldc2.conf"
"$sdk_dir/build-program.sh" "$sdk" "$stage/libexec/kandelo-d-link" "$sdk_dir/guest-link.d"
chmod 0755 "$stage/bin/ldc2" "$stage/libexec/kandelo-d-link"
cp -R "$runtime/druntime/src" "$stage/include/d/druntime"
cp -R "$runtime/phobos" "$stage/include/d/phobos"
cp -R "$sdk/ldc-build/import" "$stage/include/d/ldc"
cp "$libraries/"{libphobos2-ldc,libdruntime-ldc,libkandelo-continuation}.a "$stage/lib/d/"

digest="$("$KANDELO_ABI_STAMP_XTASK" abi-program-digest abi/snapshot.json)"
python3 - "$digest" "$work/kandelo-abi.s" <<'PY'
from pathlib import Path
import sys

digest = bytes.fromhex(sys.argv[1])
if len(digest) != 32:
    raise SystemExit("invalid Kandelo program ABI digest")
data = ",".join(str(value) for value in digest)
Path(sys.argv[2]).write_text('.section .custom_section.kandelo.abi.contract,"",@\n.byte ' + data + '\n')
PY
wasm32posix-cc -c "$work/kandelo-abi.s" -o "$stage/lib/d/kandelo-abi.o"
printf 'Guest D SDK /usr tree: %s\n' "$stage"
