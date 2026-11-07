#!/usr/bin/env bash
set -euo pipefail
# Focused component only: no setup, dependency rebuild, engine or product build.
repo_root=$(cd "$(dirname "$0")/../../../.." && pwd)
: "${NODE26_REFERENCE:?Exact audited native Node reference required}"
: "${NODE26_SOURCE:?Exact audited Node source required}"
: "${PKCS12_CONTROL_DIR:?Fresh evidence directory required}"
python3 - <<'PIN'
from pathlib import Path
import hashlib,os
assert hashlib.sha256(Path(os.environ['NODE26_REFERENCE']).read_bytes()).hexdigest()=='533bd644c5ae0e0ea3a80e433aad16b817447ccba1e1eea701875eac80cb75d4'
PIN
reference_prefix=$(cd "$(dirname "$NODE26_REFERENCE")/.." && pwd)
mkdir -p "$PKCS12_CONTROL_DIR/include"
cp "$repo_root/third_party/node-core/x509-operations.h" "$PKCS12_CONTROL_DIR/x509-operations-at-compile.h"
cp "$repo_root/third_party/node-core/tests/pkcs12-owner/addon.cpp" "$PKCS12_CONTROL_DIR/addon-at-compile.cpp"
cp "$repo_root/third_party/node-core/digest-operations.h" "$PKCS12_CONTROL_DIR/include/kandelo-node-digest-operations.h"
clang++ -std=c++20 -Wall -Wextra -Werror -shared -undefined dynamic_lookup \
 -isystem "$reference_prefix/include/node" -isystem "$NODE26_SOURCE/deps/ncrypto" \
 -I "$PKCS12_CONTROL_DIR/include" -I "$repo_root/third_party/node-core" \
 "$repo_root/third_party/node-core/tests/pkcs12-owner/addon.cpp" -o "$PKCS12_CONTROL_DIR/component.node" \
 > "$PKCS12_CONTROL_DIR/compile.stdout" 2> "$PKCS12_CONTROL_DIR/compile.stderr"
export PKCS12_COMPONENT="$PKCS12_CONTROL_DIR/component.node"
export PKCS12_CONTROL_REPORT="$PKCS12_CONTROL_DIR/report.json"
"$NODE26_REFERENCE" --expose-internals "$repo_root/third_party/node-core/tests/pkcs12-owner/control.cjs"
