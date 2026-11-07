#!/usr/bin/env bash
set -euo pipefail
: "${NODE26_REFERENCE:?Exact pinned native reference required}"
: "${TRACING_EVIDENCE_DIR:?Fresh evidence directory required}"
reference_prefix=$(cd "$(dirname "$NODE26_REFERENCE")/.." && pwd)
repo_root=$(cd "$(dirname "$0")/../../../.." && pwd)
mkdir -p "$TRACING_EVIDENCE_DIR/include"
cp "$repo_root/third_party/node-core/monotonic-clock.h" "$TRACING_EVIDENCE_DIR/include/kandelo-node-monotonic-clock.h"
python3 "$repo_root/third_party/node-core/generate-uv-error-table.py" --output "$TRACING_EVIDENCE_DIR/include/kandelo-node-uv-error-table.h"
cp "$repo_root/third_party/node-core/upstream/uv-errors/deps/uv/include/uv/errno.h" "$TRACING_EVIDENCE_DIR/include/kandelo-node-uv-errno.h"
cp "$repo_root/third_party/node-core/tracing-owner.h" "$TRACING_EVIDENCE_DIR/tracing-owner-at-compile.h"
cp "$repo_root/third_party/node-core/tests/tracing/addon.cpp" "$TRACING_EVIDENCE_DIR/addon-at-compile.cpp"
clang++ -MD -MF "$TRACING_EVIDENCE_DIR/dependencies.d" -std=c++20 -Wall -Wextra -Werror -shared -fPIC -undefined dynamic_lookup \
 -isystem "$reference_prefix/include/node" -I"$TRACING_EVIDENCE_DIR/include" \
 "$repo_root/third_party/node-core/tests/tracing/addon.cpp" -o "$TRACING_EVIDENCE_DIR/component.node"
