#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"
exec bash "$REPO_ROOT/platform/artifacts/kandelo-sdk/build-kandelo-sdk.sh" "$@"
