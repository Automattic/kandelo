#!/usr/bin/env bash
set -euo pipefail
# Actual portable TLS context/credentials only: no product setup or guest build.
repo_root=$(cd "$(dirname "$0")/../../../.." && pwd)
: "${NODE26_REFERENCE:?Set the exact audited Node26 native executable}"
: "${NODE26_SOURCE:?Set the exact audited Node26 source directory}"
: "${TLS_CREDENTIALS_CONTROL_DIR:?Set a fresh control directory}"
export TLS_CREDENTIALS_TEST_REPO="$repo_root"
export TLS_CREDENTIALS_COMPONENT="$TLS_CREDENTIALS_CONTROL_DIR/component.node"
reference_prefix=$(cd "$(dirname "$NODE26_REFERENCE")/.." && pwd)
core="$repo_root/third_party/node-core"
mkdir -p "$TLS_CREDENTIALS_CONTROL_DIR/include"
python3 "$core/generate-tls-credentials.py" --header "$TLS_CREDENTIALS_CONTROL_DIR/include/kandelo-node-tls-credential-operations.h"
python3 "$core/generate-tls-context.py" --header "$TLS_CREDENTIALS_CONTROL_DIR/include/kandelo-node-tls-context-trust.h"
cp "$core/x509-operations.h" "$TLS_CREDENTIALS_CONTROL_DIR/include/kandelo-node-x509-operations.h"
cp "$core/digest-operations.h" "$TLS_CREDENTIALS_CONTROL_DIR/include/kandelo-node-digest-operations.h"
clang++ -std=c++20 -Wall -Wextra -Werror -shared -fPIC -undefined dynamic_lookup \
 -isystem "$reference_prefix/include/node" -isystem "$NODE26_SOURCE/deps/ncrypto" \
 -I "$TLS_CREDENTIALS_CONTROL_DIR/include" -I "$core" \
 "$core/tests/tls-credentials-owner/addon.cpp" -o "$TLS_CREDENTIALS_COMPONENT"
"$NODE26_REFERENCE" --expose-gc "$core/tests/tls-credentials-owner/control.cjs"
"$NODE26_REFERENCE" --expose-gc "$core/tests/tls-credentials-owner/lifetime.cjs"
