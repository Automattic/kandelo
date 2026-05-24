#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/../../.." && pwd)"
cd "$REPO_ROOT"

npx tsx images/vfs/scripts/build-kandelo-sdk-vfs-image.ts
