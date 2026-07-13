#!/usr/bin/env bash

# Exercise tool resolution through both command shapes used by repository
# builds. The login-shell case is the Darwin regression: /etc/profile used to
# put Homebrew CMake and /usr/bin/make ahead of the flake-declared tools.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
CHECK_SCRIPT="$REPO_ROOT/scripts/check-dev-shell-tools.sh"
DEV_SHELL="$REPO_ROOT/scripts/dev-shell.sh"

bash "$DEV_SHELL" bash "$CHECK_SCRIPT"
bash "$DEV_SHELL" bash -lc 'exec bash "$1"' bash "$CHECK_SCRIPT"
