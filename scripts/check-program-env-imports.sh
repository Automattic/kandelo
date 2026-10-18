#!/usr/bin/env bash
# Fail if any built program imports from `env` something the host does not
# provide (HOST_ENV_IMPORTS plus the fork runtime's declared imports). See
# tools/xtask/src/program_env_imports.rs for why and what is skipped.
#
# Usage: scripts/check-program-env-imports.sh [file-or-dir...]
# Default: the program trees under local-binaries/ (not the kernel).
set -euo pipefail
REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO_ROOT"

if [ "$#" -eq 0 ]; then
    set --
    for dir in local-binaries/programs local-binaries/source-only-v1/programs \
            local-binaries/test-fixtures; do
        [ -d "$dir" ] && set -- "$@" "$dir"
    done
    if [ "$#" -eq 0 ]; then
        echo "ERROR: no built programs under local-binaries/; build them first" >&2
        exit 1
    fi
fi

HOST_TARGET="$(rustc -vV | awk '/^host/ {print $2}')"
exec cargo run -p xtask --target "$HOST_TARGET" --quiet -- \
    check-program-env-imports "$@"
