#!/usr/bin/env bash

# Resolver package builds run their recipes from extracted source trees. Prove
# the shared fork-instrument builder does not depend on inheriting the Kandelo
# repository as its current directory.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
SCRATCH="$(mktemp -d "${TMPDIR:-/tmp}/kandelo-fork-tool-cwd.XXXXXX")"
trap 'rm -rf "$SCRATCH"' EXIT

(
    cd "$SCRATCH"
    "$REPO_ROOT/scripts/build-fork-instrument-tool.sh"
)

test -x "$REPO_ROOT/tools/bin/wasm-fork-instrument"
echo "fork-instrument builder is independent of the caller cwd"
