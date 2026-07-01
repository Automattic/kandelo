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
# shellcheck source=/dev/null
source "$REPO_ROOT/sdk/activate.sh"

ARCH="${WASM_POSIX_DEP_TARGET_ARCH:-wasm32}"
if [ "$ARCH" != "wasm32" ]; then
    echo "ERROR: nginx package currently supports wasm32 only, got '$ARCH'." >&2
    exit 1
fi

# Force the upstream script to use the version this manifest pins.
export NGINX_VERSION="${WASM_POSIX_DEP_VERSION:-1.24.0}"
export NGINX_SOURCE_URL="${WASM_POSIX_DEP_SOURCE_URL:-https://nginx.org/download/nginx-${NGINX_VERSION}.tar.gz}"
export NGINX_SOURCE_SHA256="${WASM_POSIX_DEP_SOURCE_SHA256:-77a2541637b92a621e3ee76776c8b7b40cf6d707e69ba53a940283e30ff2f55d}"

bash "$REPO_ROOT/packages/registry/nginx/build-nginx-local.sh"
