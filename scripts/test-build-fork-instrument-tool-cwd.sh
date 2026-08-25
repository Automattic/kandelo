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

# A pre-existing executable is not authoritative. Its content stamp binds it
# to the current source tree, and the public wrapper must rebuild a stale copy
# before executing it.
printf 'deliberately-stale\n' > \
    "$REPO_ROOT/tools/bin/wasm-fork-instrument.input-hash"
(
    cd "$SCRATCH"
    "$REPO_ROOT/scripts/run-wasm-fork-instrument.sh" --help >/dev/null
)

# shellcheck source=fork-instrument-tool-input-hash.sh
source "$REPO_ROOT/scripts/fork-instrument-tool-input-hash.sh"
expected_hash="$(fork_instrument_tool_input_hash "$REPO_ROOT")"
IFS= read -r installed_hash < \
    "$REPO_ROOT/tools/bin/wasm-fork-instrument.input-hash"
test "$installed_hash" = "$expected_hash"

echo "fork-instrument builder is cwd-independent and rejects stale tools"
