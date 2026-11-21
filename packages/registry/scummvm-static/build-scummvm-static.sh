#!/usr/bin/env bash
set -euo pipefail
# WHY: grouped side modules are currently unsupported. Use upstream static
# engines while retaining the ordinary package's complete engine selection.
SCUMMVM_RECIPE_DIR="$(cd "$(dirname "$0")" && pwd)"
SCUMMVM_STATIC_ENGINES=1
source "$SCUMMVM_RECIPE_DIR/../scummvm/build-scummvm.sh"
