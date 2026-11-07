#!/usr/bin/env bash
set -euo pipefail
# No setup/resolver/provisioning or package/engine builds. Link identified existing native c-ares.
repo_root=$(cd "$(dirname "$0")/../../../.." && pwd)
: "${NODE26_REFERENCE:?Exact audited Node26 binary required}"
: "${DNS_ADDRESS_CARES_BUILD:?Identified native c-ares build required}"
: "${DNS_ADDRESS_CARES_SOURCE:?Exact pinned c-ares source required}"
: "${DNS_ADDRESS_CONTROL_DIR:?Fresh evidence directory required}"
python3 - <<'PIN'
from pathlib import Path
import os,hashlib
assert hashlib.sha256(Path(os.environ['NODE26_REFERENCE']).read_bytes()).hexdigest() == '533bd644c5ae0e0ea3a80e433aad16b817447ccba1e1eea701875eac80cb75d4'
PIN
reference_prefix=$(cd "$(dirname "$NODE26_REFERENCE")/.." && pwd)
mkdir -p "$DNS_ADDRESS_CONTROL_DIR"
export DNS_ADDRESS_COMPONENT="$DNS_ADDRESS_CONTROL_DIR/component.node"
export DNS_ADDRESS_REPORT="$DNS_ADDRESS_CONTROL_DIR/report.json"
c++ -std=c++20 -DCARES_NO_DEPRECATED -Wall -Wextra -Werror -pedantic -shared -fPIC -undefined dynamic_lookup \
 -I "$reference_prefix/include/node" -I "$repo_root/third_party/node-core" \
 -I "$DNS_ADDRESS_CARES_SOURCE/include" -I "$DNS_ADDRESS_CARES_BUILD" \
 "$repo_root/third_party/node-core/tests/dns-address-owner/addon.cpp" \
 "$DNS_ADDRESS_CARES_BUILD/lib/libcares.a" -o "$DNS_ADDRESS_COMPONENT" \
 > "$DNS_ADDRESS_CONTROL_DIR/compile.stdout" 2> "$DNS_ADDRESS_CONTROL_DIR/compile.stderr"
"$NODE26_REFERENCE" --expose-internals "$repo_root/third_party/node-core/tests/dns-address-owner/control.cjs"
