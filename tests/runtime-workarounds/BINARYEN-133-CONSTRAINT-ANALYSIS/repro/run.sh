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

# Print the verdict line and stop. details is JSON-escaped: it carries the
# tool's version string, which may contain quotes or backslashes.
verdict() {
  local details="$2"
  details="${details//\\/\\\\}"
  details="${details//\"/\\\"}"
  details="${details//$'\n'/\\n}"
  details="${details//$'\r'/\\r}"
  details="${details//$'\t'/\\t}"
  printf 'REPRO-VERDICT {"verdict": "%s", "details": "%s"}\n' "$1" "$details"
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
# The defect shows only as an assertion. A build without assertions (NDEBUG)
# carries no assertion text and cannot report it, so a clean run there
# proves nothing. Look for the text in the tool and its Binaryen library.
tool_path="$(command -v "$tool")"
tool_path="$(cd "$(dirname "$tool_path")" && pwd -P)/$(basename "$tool_path")"
asserts=no
for file in "$tool_path" "$(dirname "$tool_path")"/../lib/libbinaryen*; do
  if [ -f "$file" ] && LC_ALL=C grep -aq 'provesEverything' "$file"; then
    asserts=yes
  fi
done
if [ "$asserts" = no ]; then
  verdict inconclusive "$version: ${clean[*]} optimize cleanly, but this build has no assertion text to report the defect"
fi
verdict not-reproduced "$version: ${clean[*]} and control.wat optimize without the assertion"
