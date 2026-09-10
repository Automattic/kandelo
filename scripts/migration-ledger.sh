#!/usr/bin/env bash
#
# Report the rust-first campaign's headline metric: how much in-scope runtime
# TypeScript still exists, and how much Rust stands in its place.
#
# The campaign's stated goal is to move runtime platform code from
# TypeScript into Rust. That claim is checkable, and it should be checked
# per item rather than asserted at the end — an item that defers its
# deletion ("dual-write now, delete later") legitimately makes this number
# go UP, and the only way that stays honest is if someone is watching it.
#
# This is a MEASUREMENT, not a gate. A line count is a crude proxy: it
# would reward deleting comments and punish adding tests, and it cannot
# tell a real migration from code moved to a file outside the scope below.
# Read it alongside the per-item ledger in
# docs/plans/2026-09-09-rust-first-value-plan.md, never on its own.
#
# Scope matches the census: runtime platform code only. Excluded by
# intent — host/test (tests are not the platform), the build/packaging
# toolchain, benchmarks, and the browser-demo UI.
#
# Usage: scripts/migration-ledger.sh [ref [ref...]]   (default: HEAD)

set -euo pipefail
cd "$(dirname "$0")/.."

count() { # count(ref, pathspec...) -> total lines, excluding .d.ts
    local ref="$1"; shift
    git ls-tree -r --name-only "$ref" -- "$@" 2>/dev/null \
        | grep -E '\.ts$' | grep -v '\.d\.ts$' \
        | while read -r f; do git show "$ref:$f" 2>/dev/null | wc -l; done \
        | awk '{s+=$1} END{print s+0}'
}
count_rs() {
    local ref="$1"; shift
    git ls-tree -r --name-only "$ref" -- "$@" 2>/dev/null | grep -E '\.rs$' \
        | while read -r f; do git show "$ref:$f" 2>/dev/null | wc -l; done \
        | awk '{s+=$1} END{print s+0}'
}

printf '%-22s %10s %10s %10s\n' ref in-scope-TS rust fork-TS
for ref in "${@:-HEAD}"; do
    ts=$(count "$ref" host/src web-libs/kandelo-session/src)
    rs=$(count_rs "$ref" crates)
    fork=$(git ls-tree -r --name-only "$ref" -- host/src 2>/dev/null \
        | grep -E 'fork-.*\.ts$' \
        | while read -r f; do git show "$ref:$f" 2>/dev/null | wc -l; done \
        | awk '{s+=$1} END{print s+0}')
    printf '%-22s %10s %10s %10s\n' "$(git rev-parse --short "$ref")" "$ts" "$rs" "$fork"
done
