#!/usr/bin/env bash
set -euo pipefail
repo_root=$(cd "$(dirname "${BASH_SOURCE[0]}")/../../../.." && pwd)
: "${NODE_WORKER_STARTUP_REFERENCE:?Set the exact pinned Node26.13 executable}"
: "${NODE_WORKER_STARTUP_OUT:?Set a private evidence directory}"
mkdir -p "$NODE_WORKER_STARTUP_OUT"
WORKER_OPTIONS_EVIDENCE="$NODE_WORKER_STARTUP_OUT/options" \
  "$NODE_WORKER_STARTUP_REFERENCE" --expose-internals \
  "$repo_root/host/test/fixtures/node-worker-options-controls.cjs"
for mode in keys has descriptor seal freeze prevent inherited foreign inheritedSet set define delete navigatorAlias navigatorShadow; do
  "$NODE_WORKER_STARTUP_REFERENCE" --expose-internals \
    "$repo_root/host/test/fixtures/node-worker-lazy-data-native.cjs" "$mode"
done
"$NODE_WORKER_STARTUP_REFERENCE" --no-experimental-global-navigator --expose-internals \
  "$repo_root/host/test/fixtures/node-worker-lazy-data-native.cjs" navigatorDisabled
