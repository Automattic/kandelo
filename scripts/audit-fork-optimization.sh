#!/usr/bin/env bash
set -euo pipefail

if [ "$#" -lt 5 ]; then
    echo "usage: $0 PACKAGE OUTPUT LINKED_WASM BASELINE_INPUT OUTPUT_DIR [BASELINE_FLAGS...]" >&2
    exit 2
fi

package="$1"
artifact="$2"
linked="$3"
baseline="$4"
out="$5"
shift 5
repo="$(cd "$(dirname "$0")/.." && pwd)"
instrument="$repo/scripts/run-wasm-fork-instrument.sh"
unset WASM_POSIX_BUILD_ORIGINAL_STORE

for input in "$linked" "$baseline"; do
    if [ ! -f "$input" ]; then
        echo "Missing captured Wasm input: $input" >&2
        exit 2
    fi
done

# Use the same package and output lookup as the installer.
metadata="$(
    cd "$repo"
    if [ -n "${WASM_POSIX_XTASK_BIN:-}" ]; then
        "$WASM_POSIX_XTASK_BIN" build-deps output-metadata "$package" "$artifact"
    else
        host_target="$(rustc -vV | sed -n 's/^host: //p')"
        cargo run -q -p xtask --target "$host_target" -- build-deps output-metadata "$package" "$artifact"
    fi
)"

mkdir -- "$out"
printf '%s\n' "$metadata" > "$out/output-metadata.json"
{
    "${WASM_OPT:-wasm-opt}" --version
    shasum -a 256 -- "$linked" "$baseline"
    printf 'baseline flags:'
    if [ "$#" -gt 0 ]; then
        printf ' %q' "$@"
    fi
    printf '\n'
} > "$out/inputs.txt"

compare() {
    local variant="$1" input="$2" flag bytes
    shift 2
    local report_flags=()
    for flag in "$@"; do
        # The guard checks the emitted plan. The report mode has no output.
        if [ "$flag" != --require-facts ]; then
            report_flags+=("$flag")
        fi
    done

    echo "Auditing $package/$artifact ($variant)" >&2
    "$instrument" "$input" --sink-report ${report_flags[@]+"${report_flags[@]}"} > "$out/$variant.plan"
    "$instrument" "$input" -o "$out/$variant.wasm" "$@"
    bytes="$(wc -c < "$out/$variant.wasm" | tr -d '[:space:]')"
    awk -F '\t' -v variant="$variant" -v bytes="$bytes" '
        $1 == "source" { source = $2 }
        $1 == "facts" {
            n = split($2, fields, " ")
            for (i = 1; i < n; i++) if (fields[i] == "bound") bound = fields[i+1]
        }
        $1 == "A" { instrumented++ }
        $1 == "B" { boundaries++ }
        END {
            if (source == "") exit 1
            printf "%s\t%s\t%s\t%d\t%d\t%s\n", variant, source,
                bound == "" ? "-" : bound, instrumented, boundaries, bytes
        }
    ' "$out/$variant.plan"
}

{
    printf 'profile\tsource\tbound\tinstrumented\tboundaries\tfinal_bytes\n'
    compare baseline "$baseline" "$@"
    for level in Os O2 Oz; do
        compare "linked-final-$level" "$linked" --post-optimize "$level"
    done
    for level in O2 Oz; do
        compare "pre-$level-final-Os" "$linked" --pre-optimize "$level"
    done
} | tee "$out/summary.tsv"
