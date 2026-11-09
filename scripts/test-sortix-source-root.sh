#!/usr/bin/env bash
# Exercise the real conformance wrappers and SDK, without replacing their
# compiler, resolver or accounting. This checks source selection, not POSIX
# conformance: the full upstream suites remain separate required runs.
set -euo pipefail
repo_root="$(cd "$(dirname "$0")/.." && pwd)"
cd "$repo_root"
fixture="$(mktemp -d)"
trap 'rm -rf "$fixture"' EXIT
source_root="$fixture/selected source"
mkdir -p "$source_root/include/contract" "$source_root/malloc"

for runner in run-sortix-tests.sh run-browser-sortix-tests.sh; do
    cat > "$source_root/include/contract/selected.c" <<'C'
#include <stdint.h>
_Static_assert(sizeof(uint32_t) == 4, "the selected SDK must supply stdint.h");
int main(void) { return 0; }
C
    log="$fixture/$runner-positive.log"
    if ! KANDELO_SORTIX_SOURCE_ROOT="$source_root" bash "scripts/$runner" include > "$log" 2>&1; then
        cat "$log" >&2
        exit 1
    fi
    grep -Eq '^TOTAL: +1$' "$log" || { cat "$log" >&2; exit 1; }
    grep -Eq '^PASS: +1$' "$log" || { cat "$log" >&2; exit 1; }
    test -f "$source_root/build/include/contract/selected.result"

    # A compile refusal in the selected tree must remain a failure, rather
    # than silently selecting another checkout or disappearing from totals.
    printf '#error selected-source-refusal\n' > "$source_root/include/contract/selected.c"
    log="$fixture/$runner-refusal.log"
    if KANDELO_SORTIX_SOURCE_ROOT="$source_root" bash "scripts/$runner" include > "$log" 2>&1; then
        cat "$log" >&2
        echo "ERROR: $runner accepted a refused source" >&2
        exit 1
    fi
    grep -Eq '^TOTAL: +1$' "$log" || { cat "$log" >&2; exit 1; }
    grep -Eq '^FAIL: +1$' "$log" || { cat "$log" >&2; exit 1; }

    rm "$source_root/include/contract/selected.c"
    for suite in include malloc; do
        log="$fixture/$runner-empty-$suite.log"
        if KANDELO_SORTIX_SOURCE_ROOT="$source_root" bash "scripts/$runner" "$suite" > "$log" 2>&1; then
            cat "$log" >&2
            echo "ERROR: $runner accepted an empty $suite suite" >&2
            exit 1
        fi
        grep -F 'discovered 0 tests' "$log" >/dev/null || { cat "$log" >&2; exit 1; }
    done
    echo "PASS: $runner selected-source compile/refusal and empty include/runtime controls"
done
