#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/../../.." && pwd)"
cd "$REPO_ROOT"
if [ "$#" -ne 0 ] && [ "${1:-}" = "--vfs-product-manifest" ]; then
  exec node "$REPO_ROOT/node_modules/tsx/dist/cli.mjs" \
    images/vfs/scripts/staged-product-inputs.ts developer-kandelo-sdk "$@"
fi

KANDELO_SDK_TSX_TMP="$(mktemp -d /tmp/kandelo-sdk-vfs.XXXXXX)"
trap 'rm -rf -- "$KANDELO_SDK_TSX_TMP"' EXIT
TMPDIR="$KANDELO_SDK_TSX_TMP" \
  npx tsx images/vfs/scripts/build-kandelo-sdk-vfs-image.ts "$@"
