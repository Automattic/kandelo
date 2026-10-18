#!/usr/bin/env bash
# Build the KandeloCallTypes compiler plugin (KandeloCallTypes.cpp, the LLVM
# pass half, and KandeloFnCasts.cpp, the Clang AST half) into one shared
# library: build.sh <output-file>.
#
# The SDK runs this on demand (sdk/src/lib/calltypes-plugin.ts) and caches
# the result under a key derived from these sources and the LLVM identity;
# run it directly only to debug the build. It needs the dev shell
# (scripts/dev-shell.sh): the plugin must be compiled against the headers of
# the exact LLVM/Clang that loads it, which flake.nix exports as
# KANDELO_{LLVM,CLANG}_{DEV,LIB}.
set -euo pipefail
OUT=${1:?usage: build.sh <output-file>}
for v in KANDELO_LLVM_DEV KANDELO_LLVM_LIB KANDELO_CLANG_DEV KANDELO_CLANG_LIB; do
  if [ -z "${!v:-}" ] || [ ! -d "${!v}" ]; then
    echo "build.sh: $v is unset or missing; build the plugin inside scripts/dev-shell.sh" >&2
    exit 1
  fi
done
SRC=$(cd "$(dirname "$0")" && pwd)
# The plugin shares clang's C++ runtime: nixpkgs builds LLVM with libc++ on
# Darwin and libstdc++ on Linux. -fno-rtti matches LLVM's own build.
STDLIB=()
[ "$(uname -s)" = Darwin ] && STDLIB=(-stdlib=libc++)
clang++ -std=c++17 "${STDLIB[@]}" -fno-rtti -fPIC -shared -O2 \
  -I"$KANDELO_LLVM_DEV/include" -I"$KANDELO_CLANG_DEV/include" \
  "$SRC/KandeloCallTypes.cpp" "$SRC/KandeloFnCasts.cpp" \
  -L"$KANDELO_LLVM_LIB/lib" -L"$KANDELO_CLANG_LIB/lib" -lLLVM -lclang-cpp \
  -Wl,-rpath,"$KANDELO_LLVM_LIB/lib" -Wl,-rpath,"$KANDELO_CLANG_LIB/lib" \
  -o "$OUT"
