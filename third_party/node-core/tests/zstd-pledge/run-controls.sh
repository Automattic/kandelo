#!/usr/bin/env bash
set -euo pipefail
repo_root=$(cd "$(dirname "$0")/../../../.." && pwd)
: "${NODE26_REFERENCE:?Exact pinned native executable required}"
: "${ZSTD_PLEDGE_CONTROL_DIR:?Fresh evidence directory required}"
reference_prefix=$(cd "$(dirname "$NODE26_REFERENCE")/.." && pwd)
mkdir -p "$ZSTD_PLEDGE_CONTROL_DIR"
export ZSTD_PLEDGE_COMPONENT="$ZSTD_PLEDGE_CONTROL_DIR/component.node"
cp "$repo_root/third_party/node-core/codec-pledge.h" "$ZSTD_PLEDGE_CONTROL_DIR/codec-pledge-at-compile.h"
cp "$repo_root/third_party/node-core/tests/zstd-pledge/addon.cpp" "$ZSTD_PLEDGE_CONTROL_DIR/addon-at-compile.cpp"
clang++ -MD -MF "$ZSTD_PLEDGE_CONTROL_DIR/dependencies.d" -std=c++20 -Wall -Wextra -Werror -shared -fPIC -undefined dynamic_lookup \
 -isystem "$reference_prefix/include/node" "$repo_root/third_party/node-core/tests/zstd-pledge/addon.cpp" -o "$ZSTD_PLEDGE_COMPONENT"
"$NODE26_REFERENCE" --expose-internals "$repo_root/third_party/node-core/tests/zstd-pledge/control.cjs"
