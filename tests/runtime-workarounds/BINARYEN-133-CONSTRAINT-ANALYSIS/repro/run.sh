#!/usr/bin/env bash
# Self-judging reproduction of Binaryen 133's constraint-analysis abort:
#   Assertion failed: (!constraints.provesEverything()) ... constraint.cpp
# The inputs contain no Kandelo code:
#   upstream-9258.wat       the regression function from WebAssembly/binaryen#9258
#   ffplay-dwt-reduced.wat  wasm-reduce output from FFmpeg's ff_spatial_dwt
#                           (libavcodec/snow_dwt.c) built by LLVM 23
#   control.wat             a shape the pass handles; proves the pass can run
# Usage (from any directory): bash run.sh
# WASM_OPT selects the wasm-opt under test (default: wasm-opt on PATH).
# The last line is REPRO-VERDICT {"verdict": ..., "details": ...}.
set -u
here="$(cd "$(dirname "$0")" && pwd)"
tool="${WASM_OPT:-wasm-opt}"

verdict() {
  printf 'REPRO-VERDICT {"verdict": "%s", "details": "%s"}\n' "$1" "$2"
  exit 0
}

version="$("$tool" --version 2>/dev/null | head -n 1)"
[ -n "$version" ] || verdict inconclusive "cannot run $tool"
if ! "$tool" --help 2>/dev/null | grep -q -- '--constraint-analysis'; then
  verdict inconclusive "$version has no constraint-analysis pass"
fi

# Sanity: the pass completes on the control input.
if ! "$tool" "$here/control.wat" --constraint-analysis -o /dev/null 2>/dev/null; then
  verdict inconclusive "$version: the pass failed on control.wat"
fi

aborted=()
clean=()
for input in upstream-9258.wat ffplay-dwt-reduced.wat; do
  err="$("$tool" "$here/$input" --constraint-analysis -o /dev/null 2>&1)"
  status=$?
  if printf '%s' "$err" | grep -q 'provesEverything'; then
    aborted+=("$input")
  elif [ "$status" -ne 0 ]; then
    verdict inconclusive "$version: $input failed (exit $status) without the provesEverything assertion"
  else
    clean+=("$input")
  fi
done

if [ "${#aborted[@]}" -gt 0 ]; then
  verdict reproduced "$version: provesEverything assertion on ${aborted[*]}; control.wat ok"
fi
verdict not-reproduced "$version: ${clean[*]} and control.wat optimize without the assertion"
