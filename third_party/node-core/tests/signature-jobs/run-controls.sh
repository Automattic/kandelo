#!/usr/bin/env bash
set -euo pipefail
repo_root=$(cd "$(dirname "$0")/../../../.." && pwd)
: "${NODE26_REFERENCE:?Exact pinned native executable required}"
: "${NODE26_SOURCE:?Exact pinned source required}"
: "${SIGNATURE_JOBS_CONTROL_DIR:?Fresh evidence directory required}"
reference_prefix=$(cd "$(dirname "$NODE26_REFERENCE")/.." && pwd)
mkdir -p "$SIGNATURE_JOBS_CONTROL_DIR/include"
export SIGNATURE_JOBS_COMPONENT="$SIGNATURE_JOBS_CONTROL_DIR/component.node"
cp "$repo_root/third_party/node-core/key-operations.h" "$SIGNATURE_JOBS_CONTROL_DIR/include/kandelo-node-key-operations.h"
cp "$repo_root/third_party/node-core/digest-operations.h" "$SIGNATURE_JOBS_CONTROL_DIR/include/kandelo-node-digest-operations.h"
cp "$repo_root/third_party/node-core/signature-operations.h" "$SIGNATURE_JOBS_CONTROL_DIR/include/kandelo-node-signature-operations.h"
python3 "$repo_root/third_party/node-core/generate-native-encoding.py" --output "$SIGNATURE_JOBS_CONTROL_DIR/include/kandelo-node-native-encoding.h"
python3 "$repo_root/third_party/node-core/stage-string-bytes.py" --output "$SIGNATURE_JOBS_CONTROL_DIR/include/kandelo-node-string-bytes.h"
cp "$repo_root/third_party/node-core/signature-job-operations.h" "$SIGNATURE_JOBS_CONTROL_DIR/signature-job-operations-at-compile.h"
cp "$repo_root/third_party/node-core/tests/signature-jobs/addon.cpp" "$SIGNATURE_JOBS_CONTROL_DIR/addon-at-compile.cpp"
clang++ -MD -MF "$SIGNATURE_JOBS_CONTROL_DIR/dependencies.d" -std=c++20 -Wall -Wextra -Werror -shared -fPIC -undefined dynamic_lookup \
 -isystem "$reference_prefix/include/node" -isystem "$NODE26_SOURCE/deps/ncrypto" \
 -I "$SIGNATURE_JOBS_CONTROL_DIR/include" -I "$repo_root/third_party/node-core" \
 "$repo_root/third_party/node-core/tests/signature-jobs/addon.cpp" -o "$SIGNATURE_JOBS_COMPONENT"
"$NODE26_REFERENCE" --expose-internals --expose-gc "$repo_root/third_party/node-core/tests/signature-jobs/control.cjs"
