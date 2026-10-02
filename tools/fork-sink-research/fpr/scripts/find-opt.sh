#!/usr/bin/env bash
# Find the wasm-opt sequence that turns a captured link into the captured
# instrumenter input: find-opt.sh <link.wasm> <instr.in.wasm> <scratch-dir>
set -uo pipefail
L=$1 I=$2 S=$3; mkdir -p "$S"
for seq in "-O2" "-Os" "-O3" "-Oz" "-O1" "-O2 -O2" "-Os -O2" "-O2 -Os" "-Os -Os" "-O3 -O2" "-Oz -O2" "-g,-O2" "-O2 -g,-O2" "-Os -g,-O2" "-g,-O2 -g,-O2" "-g,-Os"; do
  cur=$L; k=0
  for f in $seq; do k=$((k+1)); wasm-opt "$cur" ${f//,/ } -o "$S/step$k.wasm" 2>/dev/null || { echo "fail $seq"; continue 2; }; cur="$S/step$k.wasm"; done
  if cmp -s "$cur" "$I"; then echo "MATCH: $seq"; exit 0; fi
  wasm-opt "$cur" --strip-debug -o "$S/s.wasm" 2>/dev/null
  if cmp -s "$S/s.wasm" "$I"; then echo "MATCH (names stripped): $seq"; exit 0; fi
done
echo "no match"; exit 1
