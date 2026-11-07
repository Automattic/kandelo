#!/usr/bin/env bash
# Run under scripts/dev-shell.sh. Native Darwin Node/OpenSSL component only.
set -euo pipefail
node_bin=${1:?provide pinned Node26.13.0 native binary}
node_source=${2:?provide pinned Node26.13.0 source directory}
out=${3:?provide private output directory}
here=$(cd "$(dirname "$0")" && pwd)
core=$(cd "$here/../.." && pwd)
node_prefix=$(cd "$(dirname "$node_bin")/.." && pwd)
mkdir -p "$out"
clang++ -std=c++20 -shared -fPIC -undefined dynamic_lookup \
  -I"$node_prefix/include/node" -I"$core" \
  "$here/component.cpp" -o "$out/component.node"
"$node_bin" "$here/control.cjs" "$out/component.node" "$node_source"
