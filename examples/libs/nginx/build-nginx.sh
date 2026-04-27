#!/usr/bin/env bash
# V2 build wrapper. The actual nginx build lives at
# examples/nginx/build.sh (predates the V2 deps.toml registry); this
# wrapper exists so the V2 resolver finds a build script in the
# registry dir.
#
# The upstream script already installs into local-binaries/ via
# scripts/install-local-binary.sh. Under the V2 resolver,
# WASM_POSIX_DEP_OUT_DIR is also set, and the helper now copies into
# the scratch dir too — so the produced nginx.wasm flows through both
# paths correctly.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"

# Force the upstream script to use the version this manifest pins.
export NGINX_VERSION="${WASM_POSIX_DEP_VERSION:-1.24.0}"

bash "$REPO_ROOT/examples/nginx/build.sh"
