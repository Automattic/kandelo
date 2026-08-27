#!/usr/bin/env bash
# Internal runner for `./run.sh setup`. Enters nothing itself; must be
# invoked inside the repository dev shell (run.sh does that).
set -euo pipefail
REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd -P)"
: "${KANDELO_DEV_SHELL_TOOL_PATH:?setup must run in the repository dev shell}"
export PATH="$KANDELO_DEV_SHELL_TOOL_PATH"
host_target="$(rustc -vV | awk '/^host/{print $2}')"
[ -n "$host_target" ] || { echo "setup.sh: no rustc host target" >&2; exit 1; }
exec cargo run -p xtask --target "$host_target" -- bootstrap "$@"
