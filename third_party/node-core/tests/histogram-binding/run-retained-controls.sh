#!/usr/bin/env bash
set -euo pipefail
repo_root=$(cd "$(dirname "${BASH_SOURCE[0]}")/../../../.." && pwd)
owner_root="$repo_root/third_party/node-core"
hdr_root="$owner_root/upstream/histogram-reference/deps/histogram"
: "${HISTOGRAM_RETAINED_OUT:?Set a private evidence directory}"
mkdir -p "$HISTOGRAM_RETAINED_OUT"
python3 "$owner_root/generate-histogram-owner.py" --check
for control in retained-memory-control retained-memory-oom-control; do
  c++ -std=c++20 -O2 -pthread -I"$owner_root" \
    "$owner_root/tests/histogram-binding/$control.cc" -o "$HISTOGRAM_RETAINED_OUT/$control"
  "$HISTOGRAM_RETAINED_OUT/$control"
done
cc -std=c11 -O2 -I"$hdr_root/include" -c "$hdr_root/src/hdr_histogram.c" -o "$HISTOGRAM_RETAINED_OUT/hdr.o"
c++ -std=c++20 -O2 -pthread -I"$owner_root" -I"$hdr_root/include" \
  "$owner_root/histogram-owner.cc" "$owner_root/histogram-window.cc" \
  "$owner_root/tests/histogram-binding/histogram-retained-control.cc" \
  "$HISTOGRAM_RETAINED_OUT/hdr.o" -o "$HISTOGRAM_RETAINED_OUT/histogram-retained-control"
"$HISTOGRAM_RETAINED_OUT/histogram-retained-control"
