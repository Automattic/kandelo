#!/usr/bin/env bash
set -euo pipefail
# Focused host component/native controls only; no global setup or guest build.
repo_root=$(cd "$(dirname "$0")/../../../.." && pwd)
: "${NODE26_REFERENCE:?Set the exact audited Node26 reference executable}"
: "${WASI_OWNER_CONTROL_DIR:?Set a fresh isolated control directory}"
export WASI_OWNER_TEST_REPO="$repo_root"
export WASI_OWNER_COMPONENT="$WASI_OWNER_CONTROL_DIR/component-addon.node"
mkdir -p "$WASI_OWNER_CONTROL_DIR"
core="$repo_root/third_party/node-core"
reference_prefix=$(cd "$(dirname "$NODE26_REFERENCE")/.." && pwd)
includes=(-I"$core" -I"$core/upstream/wasi/deps/uvwasi/include")
clang -std=c11 -Wall -Wextra -Werror "${includes[@]}" -c "$core/upstream/wasi/deps/uvwasi/src/wasi_serdes.c" -o "$WASI_OWNER_CONTROL_DIR/wasi-serdes.o"
for name in owner-smoke owner-faults; do
  clang++ -std=c++20 -Wall -Wextra -Werror -pthread "${includes[@]}" "$core/tests/wasi-owner/$name.cpp" "$WASI_OWNER_CONTROL_DIR/wasi-serdes.o" -o "$WASI_OWNER_CONTROL_DIR/$name"
  "$WASI_OWNER_CONTROL_DIR/$name"
done
clang++ -std=c++20 -Wall -Wextra -Werror -pthread -shared -fPIC -undefined dynamic_lookup -I"$reference_prefix/include/node" "${includes[@]}" "$core/tests/wasi-owner/component-addon.cpp" "$WASI_OWNER_CONTROL_DIR/wasi-serdes.o" -o "$WASI_OWNER_COMPONENT"
for mode in native component; do
  for case in lifecycle memory fds; do
    "$NODE26_REFERENCE" --expose-gc "$core/tests/wasi-owner/differential.cjs" "$mode" "$case"
  done
done
# Preserve the actual known mismatch as a strict failing assertion. Do not
# count this implementation prerequisite as passing or unsupported coverage.
"$NODE26_REFERENCE" "$core/tests/wasi-owner/differential.cjs" native direct-negative
"$NODE26_REFERENCE" "$core/tests/wasi-owner/differential.cjs" component direct-negative
