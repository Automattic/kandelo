#!/usr/bin/env bash
# Explicit native Darwin component; invoke through scripts/dev-shell.sh.
set -euo pipefail
node_bin=${1:?provide pinned Node26.13 native binary}
node_source=${2:?provide exact matching source tree}
out=${3:?provide private output directory}
here=$(cd "$(dirname "$0")" && pwd)
core=$(cd "$here/../.." && pwd)
node_prefix=$(cd "$(dirname "$node_bin")/.." && pwd)
mkdir -p "$out"
clang++ -std=c++20 -shared -fPIC -undefined dynamic_lookup \
  -I"$node_prefix/include/node" -I"$core" "$here/component.cpp" -o "$out/component.node"
for mode in orderly abrupt reentry; do
  env -u NODE_OPTIONS "$node_bin" "$here/control.cjs" "$mode" "$out/component.node" "$node_source" \
    > "$out/$mode.stdout" 2> "$out/$mode.stderr"
done
env -u NODE_OPTIONS "$node_bin" "$here/native-reference.cjs" \
  > "$out/native-reference.stdout" 2> "$out/native-reference.stderr"
