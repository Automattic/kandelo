#!/usr/bin/env bash
# Build packages and their whole dependency closure from source into a
# scratch source-only cache, with the research shims (plugin side files,
# pre-wasm-opt link copies, instrumenter input/output copies).
# Run under scripts/dev-shell.sh from the repo root:
#   build-corpus.sh <shim-dir> <scratch-cache-root> <package>...
# The shared ~/.cache/kandelo caches are never written.
set -uo pipefail
SHIMS=$(cd "$1" && pwd); CACHE=$(mkdir -p "$2" && cd "$2" && pwd); shift 2
export WASM_POSIX_LLVM_DIR="$SHIMS/llvm"
export WASM_POSIX_FORK_INSTRUMENT="$SHIMS/instrument"
export WASM_POSIX_SOURCE_ONLY_CACHE_ROOT="$CACHE"
export KANDELO_CACHE_GC_AUTO=0
H=$(rustc -vV | awk '/^host/ {print $2}')
X=${XTASK:-target/$H/debug/xtask}
for p in "$@"; do
  start=$(date +%s)
  "$X" build-deps --arch wasm32 --source-only resolve "$p" > "$CACHE/build-$p.log" 2>&1
  echo "$p rc=$? secs=$(( $(date +%s) - start )) load=$(uptime | sed 's/.*averages*: //')"
done
