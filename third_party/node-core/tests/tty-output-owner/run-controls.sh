#!/usr/bin/env bash
set -euo pipefail
# Focused native POSIX controls only. No global setup or guest/package build.
repo_root=$(cd "$(dirname "$0")/../../../.." && pwd)
: "${NODE26_REFERENCE:?Set the exact audited Darwin-arm64 Node26 reference}"
: "${TTY_OUTPUT_CONTROL_DIR:?Set a fresh isolated evidence directory}"
export TTY_OUTPUT_TEST_REPO="$repo_root"
export TTY_OUTPUT_COMPONENT="$TTY_OUTPUT_CONTROL_DIR/window.node"
mkdir -p "$TTY_OUTPUT_CONTROL_DIR"
reference_prefix=$(cd "$(dirname "$NODE26_REFERENCE")/.." && pwd)
c++ -std=c++20 -Wall -Wextra -Werror -pedantic -shared -fPIC -undefined dynamic_lookup -I "$reference_prefix/include/node" -I "$repo_root/third_party/node-core" "$repo_root/third_party/node-core/tests/tty-output-owner/addon.cpp" -o "$TTY_OUTPUT_COMPONENT" > "$TTY_OUTPUT_CONTROL_DIR/compile.stdout" 2> "$TTY_OUTPUT_CONTROL_DIR/compile.stderr"
c++ -std=c++20 -Wall -Wextra -Werror -pedantic -I "$repo_root/third_party/node-core" "$repo_root/third_party/node-core/tests/tty-output-owner/same-number.cpp" -o "$TTY_OUTPUT_CONTROL_DIR/same-number" > "$TTY_OUTPUT_CONTROL_DIR/same-number.compile.stdout" 2> "$TTY_OUTPUT_CONTROL_DIR/same-number.compile.stderr"
"$TTY_OUTPUT_CONTROL_DIR/same-number" > "$TTY_OUTPUT_CONTROL_DIR/same-number.report"
python3 "$repo_root/third_party/node-core/tests/tty-output-owner/run.py"
python3 "$repo_root/third_party/node-core/tests/tty-output-owner/run-ownership.py"
python3 "$repo_root/third_party/node-core/tests/tty-output-owner/run-size-owner.py"
# This strict comparison currently fails for the real unsupported master path.
# Preserve its assertions and exit1 until the owning behavior is implemented.
python3 "$repo_root/third_party/node-core/tests/tty-output-owner/run-fallback.py"
