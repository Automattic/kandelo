#!/usr/bin/env bash
set -euo pipefail
: "${NODE26_REFERENCE:?Set the exact audited Node26 native reference}"
# No global setup, package/engine build, provisioning or overall suite.
"$NODE26_REFERENCE" --expose-internals "$(dirname "$0")/reference.cjs"
