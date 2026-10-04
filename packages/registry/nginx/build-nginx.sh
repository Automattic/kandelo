#!/usr/bin/env bash
# package-system build wrapper. The local nginx source build predates
# package.toml, so it still lives in a separate helper in this registry package.
#
# The helper builds under WASM_POSIX_DEP_WORK_DIR (beside this script when
# run standalone) and publishes through scripts/install-local-binary.sh:
# into WASM_POSIX_DEP_OUT_DIR under the resolver, which also suppresses the
# local-binaries/ mirror, or into local-binaries/ on a standalone run.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"

# Force the upstream script to use the version this manifest pins.
export NGINX_VERSION="${WASM_POSIX_DEP_VERSION:-1.24.0}"

bash "$REPO_ROOT/packages/registry/nginx/build-nginx-local.sh"
