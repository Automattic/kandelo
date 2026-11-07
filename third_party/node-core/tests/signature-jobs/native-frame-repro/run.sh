#!/usr/bin/env bash
set -euo pipefail
# Standalone native Node control: only Node headers/binary, libuv and compiler.
: "${NODE26_REFERENCE:?Exact native Node executable required}"
reference_prefix=$(cd "$(dirname "$NODE26_REFERENCE")/.." && pwd)
cd "$(dirname "$0")"
clang++ -std=c++20 -Wall -Wextra -Werror -shared -fPIC -undefined dynamic_lookup \
 -isystem "$reference_prefix/include/node" addon.cpp -o component.node
"$NODE26_REFERENCE" repro.cjs
