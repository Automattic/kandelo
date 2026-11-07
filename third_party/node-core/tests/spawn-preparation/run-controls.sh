#!/usr/bin/env bash
set -euo pipefail
# Tiny native fd dependency only; no product setup or guest/library build.
repo_root=$(cd "$(dirname "$0")/../../../.." && pwd)
: "${NODE26_REFERENCE:?Exact pinned native executable required}"
: "${SPAWN_CONTROL_DIR:?Fresh evidence directory required}"
reference_prefix=$(cd "$(dirname "$NODE26_REFERENCE")/.." && pwd)
mkdir -p "$SPAWN_CONTROL_DIR"
cp "$repo_root/third_party/node-core/tests/spawn-preparation/addon.cpp" "$SPAWN_CONTROL_DIR/addon-at-compile.cpp"
clang++ -std=c++20 -Wall -Wextra -Werror -shared -fPIC -undefined dynamic_lookup \
 -isystem "$reference_prefix/include/node" \
 "$repo_root/third_party/node-core/tests/spawn-preparation/addon.cpp" -o "$SPAWN_CONTROL_DIR/component.node"
