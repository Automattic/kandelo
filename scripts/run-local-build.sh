#!/usr/bin/env bash
# Internal runner for `./run.sh local-build`.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd -P)"
: "${KANDELO_DEV_SHELL_TOOL_PATH:?local build must run in the repository dev shell}"

host_target="$(rustc -vV | sed -n 's/^host: //p')"
if [ -z "$host_target" ]; then
    echo "run-local-build.sh: could not determine the Rust host target" >&2
    exit 1
fi

exec cargo run -p xtask --target "$host_target" -- local-build run \
    --set "$REPO_ROOT/packages/sets/local-supported.toml" \
    --source-cache-root "$HOME/.cache/kandelo/source-only" \
    --output-root "$REPO_ROOT/local-binaries/source-only-v1" \
    --product all \
    --jobs 16
