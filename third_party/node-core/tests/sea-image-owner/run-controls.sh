#!/usr/bin/env bash
set -euo pipefail
# One tiny native image-detector component; no global setup/product/engine suite.
repo_root=$(cd "$(dirname "$0")/../../../.." && pwd)
: "${NODE26_REFERENCE:?Exact audited Node26 executable required}"
: "${SEA_IMAGE_CONTROL_DIR:?Fresh focused evidence directory required}"
reference_prefix=$(cd "$(dirname "$NODE26_REFERENCE")/.." && pwd)
mkdir -p "$SEA_IMAGE_CONTROL_DIR/include/kandelo-node/postject"
python3 "$repo_root/third_party/node-core/generate-sea.py" --check
python3 "$repo_root/third_party/node-core/build.py" --check
cp "$repo_root/third_party/node-core/upstream/sea/deps/postject/postject-api.h" "$SEA_IMAGE_CONTROL_DIR/include/kandelo-node/postject/postject-api.h"
cp "$repo_root/third_party/node-core/sea-image-profile.h" "$SEA_IMAGE_CONTROL_DIR/header-at-compile.h"
cp "$repo_root/third_party/node-core/tests/sea-image-owner/addon.cpp" "$SEA_IMAGE_CONTROL_DIR/addon-at-compile.cpp"
export SEA_IMAGE_COMPONENT="$SEA_IMAGE_CONTROL_DIR/component.node"
clang++ -MD -MF "$SEA_IMAGE_CONTROL_DIR/dependencies.d" -std=c++20 -Wall -Wextra -Werror -shared -fPIC -undefined dynamic_lookup \
 -isystem "$reference_prefix/include/node" -isystem "$SEA_IMAGE_CONTROL_DIR/include" \
 "$repo_root/third_party/node-core/tests/sea-image-owner/addon.cpp" -o "$SEA_IMAGE_COMPONENT"
"$NODE26_REFERENCE" --expose-internals "$repo_root/third_party/node-core/tests/sea-image-owner/control.cjs"
