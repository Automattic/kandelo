#!/usr/bin/env bash
#
# The rust-first campaign's headline metric: how much in-scope runtime
# TypeScript still exists, how much Rust stands in its place, and what each
# step actually did to those numbers.
#
# The campaign claims runtime platform code is moving from TypeScript into
# Rust. That claim is checkable, and it is checked PER STEP rather than
# asserted at the end. An item that defers its deletion ("dual-write now,
# cut over later") legitimately pushes the number UP; that stays honest only
# if the increase is visible and has a named owner.
#
# This is a MEASUREMENT, not a gate. A line count rewards deleting comments,
# punishes adding tests, and cannot tell a real migration from code moved to
# a path outside the scope below. Read it beside the per-item ledger in
# docs/plans/2026-09-09-rust-first-value-plan.md, never on its own.
#
# Scope matches the census: runtime platform code only. Excluded by intent —
# host/test (tests are not the platform), the build/packaging toolchain,
# benchmarks, and the browser-demo UI.
#
# Usage:
#   scripts/migration-ledger.sh                 totals at HEAD
#   scripts/migration-ledger.sh REF [REF...]    totals at each ref
#   scripts/migration-ledger.sh --step A B      what the A..B step changed,
#                                               plus the aggregate at B

set -euo pipefail
cd "$(dirname "$0")/.."

TS_PATHS=(host/src web-libs/kandelo-session/src)
RS_PATHS=(crates)

is_scoped_ts() { case "$1" in *.d.ts) return 1;; *.ts) return 0;; *) return 1;; esac; }

totals() { # totals(ref) -> "ts rust forkts"
    local ref="$1" ts rs fork
    ts=$(git ls-tree -r --name-only "$ref" -- "${TS_PATHS[@]}" 2>/dev/null \
        | grep -E '\.ts$' | grep -v '\.d\.ts$' \
        | while read -r f; do git show "$ref:$f" 2>/dev/null | wc -l; done \
        | awk '{s+=$1} END{print s+0}')
    rs=$(git ls-tree -r --name-only "$ref" -- "${RS_PATHS[@]}" 2>/dev/null | grep -E '\.rs$' \
        | while read -r f; do git show "$ref:$f" 2>/dev/null | wc -l; done \
        | awk '{s+=$1} END{print s+0}')
    fork=$(git ls-tree -r --name-only "$ref" -- host/src 2>/dev/null | grep -E 'fork-.*\.ts$' \
        | while read -r f; do git show "$ref:$f" 2>/dev/null | wc -l; done \
        | awk '{s+=$1} END{print s+0}')
    echo "$ts $rs $fork"
}

# added/removed/net across a range, restricted to a pathspec + extension.
step() { # step(a, b, ext, paths...)
    local a="$1" b="$2" ext="$3"; shift 3
    git diff --numstat "$a".."$b" -- "$@" 2>/dev/null \
        | awk -v ext="$ext" '$3 ~ ext && $3 !~ /\.d\.ts$/ {add+=$1; del+=$2}
                             END{printf "%d %d %d\n", add+0, del+0, (add+0)-(del+0)}'
}

if [ "${1:-}" = "--step" ]; then
    a="$2"; b="$3"
    read -r tadd tdel tnet <<<"$(step "$a" "$b" '\.ts$' "${TS_PATHS[@]}")"
    read -r radd rdel rnet <<<"$(step "$a" "$b" '\.rs$' "${RS_PATHS[@]}")"
    # Rust TEST code counted separately. Counting tests as "Rust added"
    # reads as implementation bloat when it is the opposite: the Bar demands
    # that coverage, and for a migration the differential harness IS the
    # gate that licenses deleting the TypeScript. Split so the number means
    # what a reader will take it to mean.
    read -r tsadd tsdel tsnet <<<"$(git diff --numstat "$a".."$b" -- "${RS_PATHS[@]}" 2>/dev/null \
        | awk '$3 ~ /\.rs$/ && ($3 ~ /\/tests\// || $3 ~ /test/) {add+=$1; del+=$2}
               END{printf "%d %d %d\n", add+0, del+0, (add+0)-(del+0)}')"
    printf 'step %s..%s\n' "$(git rev-parse --short "$a")" "$(git rev-parse --short "$b")"
    printf '  %-12s %8s %8s %8s\n' '' added removed net
    printf '  %-12s %8s %8s %+8d\n' 'in-scope TS' "$tadd" "$tdel" "$tnet"
    printf '  %-12s %8s %8s %+8d\n' 'Rust (all)'  "$radd" "$rdel" "$rnet"
    printf '  %-12s %8s %8s %+8d\n' '  of which test' "$tsadd" "$tsdel" "$tsnet"
    printf '  %-12s %8s %8s %+8d\n' '  production'  "$((radd-tsadd))" "$((rdel-tsdel))" "$((rnet-tsnet))"
    read -r ts rs fork <<<"$(totals "$b")"
    printf '  aggregate at %s: TS %s  Rust %s  (fork TS %s)\n' \
        "$(git rev-parse --short "$b")" "$ts" "$rs" "$fork"
    exit 0
fi

printf '%-12s %12s %10s %10s\n' ref in-scope-TS rust fork-TS
for ref in "${@:-HEAD}"; do
    read -r ts rs fork <<<"$(totals "$ref")"
    printf '%-12s %12s %10s %10s\n' "$(git rev-parse --short "$ref")" "$ts" "$rs" "$fork"
done
