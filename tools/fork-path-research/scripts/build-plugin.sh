#!/usr/bin/env bash
# Build the KandeloCallTypes pass plugin against the dev shell's LLVM.
# Run under scripts/dev-shell.sh. Output: $FPR_OUT/KandeloCallTypes.dylib
# (default .context/fpr). The LLVM dev headers are a separate Nix output
# that garbage collection may remove; pin them with an indirect GC root.
set -euo pipefail
ROOT=$(git rev-parse --show-toplevel)
OUT=${FPR_OUT:-$ROOT/.context/fpr}
mkdir -p "$OUT"
# The dev shell does not put nix on PATH; use the host's.
NIX_BIN=${NIX_BIN:-/nix/var/nix/profiles/default/bin}
nix() { "$NIX_BIN/nix" "$@"; }
nix-store() { "$NIX_BIN/nix-store" "$@"; }
DEV=$(nix eval --raw --inputs-from "$ROOT" nixpkgs#llvmPackages_21.llvm.dev.outPath)
LIB=$(nix eval --raw --inputs-from "$ROOT" nixpkgs#llvmPackages_21.llvm.lib.outPath)
nix-store --realise "$DEV" --add-root "$OUT/llvm-dev-gcroot" --indirect >/dev/null
nix-store --realise "$LIB" --add-root "$OUT/llvm-lib-gcroot" --indirect >/dev/null
SRC=$(dirname "$0")/../plugin/KandeloCallTypes.cpp
clang++ -std=c++17 -stdlib=libc++ -fno-rtti -fPIC -shared -O2 \
  -I"$DEV/include" "$SRC" -L"$LIB/lib" -lLLVM -Wl,-rpath,"$LIB/lib" \
  -o "$OUT/KandeloCallTypes.dylib"
echo "$OUT/KandeloCallTypes.dylib"
