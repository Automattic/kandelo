#!/usr/bin/env bash
# package-system build wrapper. The local nginx source build predates
# package.toml, so it still lives in a separate helper in this registry package.
#
# The upstream script already installs into local-binaries/ via
# scripts/install-local-binary.sh. Under the package-system resolver,
# WASM_POSIX_DEP_OUT_DIR is also set, and the helper now copies into
# the scratch dir too — so the produced nginx.wasm flows through both
# paths correctly.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"

# Force the upstream script to use the version this manifest pins.
export NGINX_VERSION="${WASM_POSIX_DEP_VERSION:-1.24.0}"

bash "$REPO_ROOT/packages/registry/nginx/build-nginx-local.sh"
