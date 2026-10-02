#!/usr/bin/env bash
# Build the KandeloCallTypes plugin (LLVM pass + Clang AST pass) against the
# dev shell's LLVM/Clang 21. Run under scripts/dev-shell.sh.
# Output: $FPR_OUT/KandeloCallTypes.dylib (default .context/fpr2). The dev
# headers are separate Nix outputs that garbage collection may remove; pin
# them with indirect GC roots.
# Copied from ljubljana tools/fork-path-research (4d3ffb4a5) and extended
# with the Clang half (KandeloFnCasts.cpp).
set -euo pipefail
ROOT=$(git rev-parse --show-toplevel)
OUT=${FPR_OUT:-$ROOT/.context/fpr2}
mkdir -p "$OUT"
NIX_BIN=${NIX_BIN:-/nix/var/nix/profiles/default/bin}
nix() { "$NIX_BIN/nix" "$@"; }
nix-store() { "$NIX_BIN/nix-store" "$@"; }
p() { nix eval --raw --inputs-from "$ROOT" "nixpkgs#llvmPackages_21.$1.outPath"; }
DEV=$(p llvm.dev); LIB=$(p llvm.lib); CDEV=$(p clang-unwrapped.dev); CLIB=$(p clang-unwrapped.lib)
for x in DEV LIB CDEV CLIB; do nix-store --realise "${!x}" --add-root "$OUT/$x-gcroot" --indirect >/dev/null; done
SRC=$(cd "$(dirname "$0")/../plugin" && pwd)
clang++ -std=c++17 -stdlib=libc++ -fno-rtti -fPIC -shared -O2 \
  -I"$DEV/include" -I"$CDEV/include" "$SRC/KandeloCallTypes.cpp" "$SRC/KandeloFnCasts.cpp" \
  -L"$LIB/lib" -L"$CLIB/lib" -lLLVM -lclang-cpp -Wl,-rpath,"$LIB/lib" -Wl,-rpath,"$CLIB/lib" \
  -o "$OUT/KandeloCallTypes.dylib.new" && mv -f "$OUT/KandeloCallTypes.dylib.new" "$OUT/KandeloCallTypes.dylib"
echo "$OUT/KandeloCallTypes.dylib"
