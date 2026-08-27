#!/bin/bash
set -euo pipefail

# Builds the TypeScript host (host/dist). Extracted from build.sh so both the
# legacy build.sh path and the xtask bootstrap engine share one definition of
# "build the host" instead of two copies drifting apart.

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"

# shellcheck source=build-step-input-hash.sh
source "$REPO_ROOT/scripts/build-step-input-hash.sh"

# host/dist is a pure function of host/ source + toolchain config: tsup does
# not inline rootfs/kernel bytes into the built entries (the `@rootfs-vfs?url`
# imports are Vite-only and unreachable from tsup's entry points), so no
# binary/rootfs/kernel input belongs in this set.
OUT="$REPO_ROOT/host/dist"
STAMP="$OUT/.input-hash"
HOST_INPUT_HASH="$(repo_input_hash "$REPO_ROOT" \
    host/src \
    host/tsup.config.ts \
    host/tsconfig.json \
    host/package.json \
    host/package-lock.json \
    scripts/build-host.sh \
    scripts/build-step-input-hash.sh)"

if [ "${KANDELO_BOOTSTRAP_FORCE_REBUILD:-0}" != "1" ] &&
   build_step_is_current "$OUT/index.cjs" "$STAMP" "$HOST_INPUT_HASH"; then
    echo "==> host/dist up to date ($HOST_INPUT_HASH)"
    exit 0
fi

echo "Building TypeScript host..."
cd "$REPO_ROOT/host"
npm install --prefer-offline
npm run build

mkdir -p "$OUT"
write_build_stamp "$STAMP" "$HOST_INPUT_HASH"
