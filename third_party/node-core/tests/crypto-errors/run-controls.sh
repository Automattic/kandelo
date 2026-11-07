#!/usr/bin/env bash
set -euo pipefail
# Focused portable owner only; no setup or engine/product/library build.
repo_root=$(cd "$(dirname "$0")/../../../.." && pwd)
: "${NODE26_REFERENCE:?Exact pinned native executable required}"
: "${NODE26_SOURCE:?Exact pinned source required}"
: "${CRYPTO_ERRORS_CONTROL_DIR:?Fresh control directory required}"
: "${TLS_CREDENTIALS_COMPONENT:?Actual TLS credential component required}"
reference_prefix=$(cd "$(dirname "$NODE26_REFERENCE")/.." && pwd)
mkdir -p "$CRYPTO_ERRORS_CONTROL_DIR"
export CRYPTO_ERRORS_COMPONENT="$CRYPTO_ERRORS_CONTROL_DIR/component.node"
export CRYPTO_ERRORS_REPO="$repo_root"
clang++ -std=c++20 -Wall -Wextra -Werror -shared -fPIC -undefined dynamic_lookup \
 -isystem "$reference_prefix/include/node" -isystem "$NODE26_SOURCE/deps/ncrypto" \
 "$repo_root/third_party/node-core/tests/crypto-errors/addon.cpp" -o "$CRYPTO_ERRORS_COMPONENT"
"$NODE26_REFERENCE" "$repo_root/third_party/node-core/tests/crypto-errors/control.cjs"
"$NODE26_REFERENCE" --expose-gc "$repo_root/third_party/node-core/tests/crypto-errors/prototype-control.cjs"
