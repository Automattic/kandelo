#!/usr/bin/env bash
# Thin wrapper around the Rust `xtask check-determinism` tool: build the
# project twice with the incidental environment varied and diff the outputs to
# discover non-reproducible packages. The implementation is Rust
# (tools/xtask/src/determinism_check.rs); this wrapper enters the pinned dev
# shell, ensures the repo-local JS build dependencies are present (the
# source-only build of the *-browser-bundle packages shells out to the
# repo-locked `tsx`, which `./run.sh setup` does not install), and forwards
# arguments.
#
# Usage:
#   scripts/check-determinism.sh [--product <id>] [--scratch <dir>] \
#                                [--report <file>] [--jobs N]
#   scripts/check-determinism.sh diff <dir-a> <dir-b>
#
# Defaults build the browser-main-shell product from the local-supported set.
# Heavy: this performs two full builds. Exit status is non-zero if any package
# is non-reproducible.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

SET="packages/sets/local-supported.toml"
PRODUCT="browser-main-shell"
SCRATCH="${TMPDIR:-/tmp}/kandelo-determinism"
REPORT="$REPO_ROOT/determinism-report.txt"
JOBS="8"

# `diff <a> <b>` passthrough mode: forward verbatim to the Rust tool.
if [ "${1:-}" = "diff" ]; then
    exec bash "$REPO_ROOT/scripts/dev-shell.sh" bash -c '
        cd "'"$REPO_ROOT"'"
        HOST_TARGET="$(rustc -vV | awk "/^host:/{print \$2}")"
        cargo run --release -q -p xtask --target "$HOST_TARGET" -- check-determinism "$@"
    ' bash "$@"
fi

while [ "$#" -gt 0 ]; do
    case "$1" in
        --product) PRODUCT="$2"; shift 2 ;;
        --scratch) SCRATCH="$2"; shift 2 ;;
        --report) REPORT="$2"; shift 2 ;;
        --jobs) JOBS="$2"; shift 2 ;;
        --set) SET="$2"; shift 2 ;;
        *) echo "check-determinism.sh: unknown argument $1" >&2; exit 2 ;;
    esac
done

exec bash "$REPO_ROOT/scripts/dev-shell.sh" bash -c '
    cd "'"$REPO_ROOT"'"
    # Ensure repo-local JS build deps (tsx) are installed. The source-only
    # build of node-browser-bundle runs the repo-locked tsx CLI; `./run.sh
    # setup` never installs root node_modules (only the `./run.sh run` path
    # does), so provision it here from the committed lockfile. Idempotent:
    # a no-op once node_modules exists.
    [ -d node_modules ] || npm ci
    HOST_TARGET="$(rustc -vV | awk "/^host:/{print \$2}")"
    cargo run --release -q -p xtask --target "$HOST_TARGET" -- \
        check-determinism run \
        --set "'"$SET"'" \
        --product "'"$PRODUCT"'" \
        --scratch "'"$SCRATCH"'" \
        --jobs "'"$JOBS"'" \
        --report "'"$REPORT"'"
'
