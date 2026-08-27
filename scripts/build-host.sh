#!/bin/bash
set -euo pipefail

# Builds the TypeScript host (host/dist). Extracted from build.sh so both the
# legacy build.sh path and the xtask bootstrap engine share one definition of
# "build the host" instead of two copies drifting apart.

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"

echo "Building TypeScript host..."
cd "$REPO_ROOT/host"
npm install --prefer-offline
npm run build
