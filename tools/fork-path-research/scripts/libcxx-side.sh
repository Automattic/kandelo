#!/usr/bin/env bash
# Side files for libc++/libc++abi/libunwind: run the libcxx recipe standalone
# in scratch with the research shim compiler, then bind the real archives'
# members to those side files by (archive, member) in aliases.tsv.
# The recipe resolves LLVM_PREFIX itself and libcxx's cache identity binds
# it, so corpus package builds cannot use the shim prefix.
#   libcxx-side.sh <shim-dir> <runtime-dir>     (under scripts/dev-shell.sh)
set -uo pipefail
ROOT=$(git rev-parse --show-toplevel)
SHIMS=$(cd "$1" && pwd); RT=$(cd "$2" && pwd)
D="$RT/repo/packages/registry/libcxx"
rm -rf "$D" && mkdir -p "$D" "$RT/libcxx-out"
ln -sfn "$ROOT/sdk" "$RT/repo/sdk"
cp -R "$ROOT/packages/registry/libcxx/." "$D/"
rm -rf "$D"/build-wasm* "$D"/llvm-source-*
WASM_POSIX_DEP_OUT_DIR="$RT/libcxx-out" WASM_POSIX_DEP_VERSION=21.1.7 WASM_POSIX_DEP_TARGET_ARCH=wasm32 \
WASM_POSIX_SYSROOT="$ROOT/sysroot" LLVM_PREFIX="$SHIMS/prefix" \
  bash "$D/build-libcxx.sh" > "$RT/build-libcxx.log" 2>&1
echo "build-libcxx exit=$? (log $RT/build-libcxx.log)"
# The recipe deletes its objects after archiving; the compile shim's index
# recorded each object's path and hash.
python3 - "$SHIMS/side" "$D/build-wasm32/" "$RT/aliases.tsv" <<'PY'
import os, sys
side, d, aliases = sys.argv[1], os.path.realpath(sys.argv[2]) + "/", sys.argv[3]
out = []
for l in open(f"{side}/index.tsv"):
    sha, path = l.rstrip("\n").split("\t", 1)
    if not path.startswith(d):
        continue
    a = "libc++abi.a" if ("/libcxxabi/" in path or "/libunwind/" in path) else "libc++.a" if "/libcxx/" in path else None
    if a and os.path.exists(f"{side}/{sha}.calltypes"):
        out.append(f"{a}\t{os.path.basename(path)}\t{sha}\n")
open(aliases, "a").writelines(out)
print("libc++ aliases:", len(out))
PY
