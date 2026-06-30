#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"

exec node --import tsx/esm \
  "$REPO_ROOT/scripts/kandelo-browser-js-shell-client.ts" \
  "$@"
