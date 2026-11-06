#!/usr/bin/env bash
set -euo pipefail
repo_root=$(cd "$(dirname "${BASH_SOURCE[0]}")/../../../.." && pwd)
test_root="$repo_root/third_party/node-core/tests/histogram"
owner_root="$repo_root/third_party/node-core"
histogram_root="$owner_root/upstream/histogram-reference/deps/histogram"
: "${HISTOGRAM_CONTROL_OUT:?Set an evidence output directory}"
: "${HISTOGRAM_NATIVE_NODE:?Set the exact pinned native Node executable}"
mkdir -p "$HISTOGRAM_CONTROL_OUT"
sanitize_flags=()
if [[ ${HISTOGRAM_CONTROL_SANITIZE:-0} == 1 ]]; then
  sanitize_flags=(-fsanitize=address,undefined -fno-omit-frame-pointer)
  export UBSAN_OPTIONS=halt_on_error=1:print_stacktrace=1
fi
python3 "$owner_root/generate-histogram-owner.py" --check
cc -std=c11 -O2 "${sanitize_flags[@]}" -I"$histogram_root/include" -c \
  "$histogram_root/src/hdr_histogram.c" -o "$HISTOGRAM_CONTROL_OUT/hdr.o"
c++ -std=c++20 -O2 -pthread "${sanitize_flags[@]}" -I"$histogram_root/include" -I"$owner_root" \
  "$owner_root/histogram-owner.cc" "$owner_root/histogram-window.cc" \
  "$test_root/owner-control.cc" "$HISTOGRAM_CONTROL_OUT/hdr.o" \
  -o "$HISTOGRAM_CONTROL_OUT/owner-control"
python3 "$test_root/compare-controls.py" "$HISTOGRAM_CONTROL_OUT/owner-control" \
  "$HISTOGRAM_NATIVE_NODE" "$HISTOGRAM_CONTROL_OUT"
