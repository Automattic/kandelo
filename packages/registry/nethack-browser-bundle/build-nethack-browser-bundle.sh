#!/usr/bin/env bash
#
# Build the browser lazy-archive bundle for NetHack.
#
# The package-system archive remains a .tar.zst, but its declared output is
# nethack.zip. Resolver consumers see the bare zip at programs/wasm32/nethack.zip.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"

bash "$REPO_ROOT/images/vfs/scripts/build-nethack-zip.sh"
