#!/usr/bin/env bash
# Vitest evidence-class registry check.
#
# scripts/ci-vitest-evidence-classes.tsv gives every Vitest file one evidence
# class: source-only (source and the current ABI test fixtures suffice) or
# prepared-product (needs built package programs or images). The registry must
# agree with the files Vitest collects in both directions:
#   - every row names an existing regular test file, and
#   - every collected file has exactly one row.
# WHY: the only earlier two-way check ran inside the exact-ABI source lane.
# Once that lane stopped running, deleted tests kept their rows and new tests
# went unclassified without any failure. Every Vitest group now runs this
# check before any test, so drift fails in the change that causes it.
#
# ci-run-test-suite.sh sources this file. Run it directly to check the
# registry by hand (tests/package-system/vitest-evidence-classes.test.ts does,
# so a plain `npx vitest run` checks it too):
#   bash scripts/check-vitest-evidence-classes.sh

# Files that no CI-shaped Vitest run collects. The registry classifies exactly
# the files that remain.
disabled_software_vitest_excludes=(
    # Vitest is invoked from host/. Its ordinary file list includes both
    # host-local paths (test/**) and repository siblings (../tests/**), so
    # every disabled-software marker needs both spellings.
    "--exclude=**/*brew*"
    "--exclude=../**/*brew*"
    "--exclude=**/*bottle*"
    "--exclude=../**/*bottle*"
    "--exclude=**/*formula*"
    "--exclude=../**/*formula*"
    "--exclude=**/*tap*"
    "--exclude=../**/*tap*"
    # Erlang is deferred while its package/runtime validation is unstable.
    "--exclude=../packages/registry/erlang/test/**"
    "--exclude=test/abi-staging-mini-vfs.test.ts"
    "--exclude=test/abi-staging-product-builders.test.ts"
    "--exclude=test/shell-vfs-build.test.ts"
)

vitest_evidence_classes_registry="scripts/ci-vitest-evidence-classes.tsv"

vitest_evidence_fail() {
    echo "vitest evidence classes: $*" >&2
}

# read_vitest_evidence_classes <repo-root> <out-dir>
# Validates the registry rows and writes repository-relative path lists, in
# registry order, to <out-dir>/declared, <out-dir>/source-only, and
# <out-dir>/prepared-product. Needs no installed dependencies, so callers run
# it before anything else.
read_vitest_evidence_classes() {
    local root="$1"
    local out="$2"
    local classes="$root/$vitest_evidence_classes_registry"
    local path class extra
    local previous=""
    local line_number=0
    local source_count=0
    local prepared_count=0
    local stale=0
    # Registry order is byte order, matching `LC_ALL=C sort`.
    local LC_ALL=C

    if [ ! -f "$classes" ] || [ -L "$classes" ] ||
       [ "$(wc -c < "$classes" | tr -d '[:space:]')" -gt 1048576 ]; then
        vitest_evidence_fail "$vitest_evidence_classes_registry must be one bounded regular file"
        exit 2
    fi
    mkdir -p "$out"
    : > "$out/declared"
    : > "$out/source-only"
    : > "$out/prepared-product"
    while IFS=$'\t' read -r path class extra ||
          [ -n "${path:-}${class:-}${extra:-}" ]; do
        line_number=$((line_number + 1))
        case "${path:-}" in
            ""|\#*) continue ;;
        esac
        if [ -z "${class:-}" ] || [ -n "${extra:-}" ]; then
            vitest_evidence_fail "invalid Vitest evidence class at $vitest_evidence_classes_registry:$line_number"
            exit 2
        fi
        case "$path" in
            /*|*//*|../*|*/../*|*/..|./*|*/./*|*/.)
                vitest_evidence_fail "invalid Vitest evidence path at $vitest_evidence_classes_registry:$line_number"
                exit 2
                ;;
        esac
        case "$path" in
            host/test/*.test.ts|host/test/*/*.test.ts|\
            web-libs/*/test/*.test.ts|packages/registry/*/test/*.test.ts|\
            tests/package-system/*.test.ts|examples/dlopen/*.test.ts|\
            scripts/*.test.mjs)
                ;;
            *)
                vitest_evidence_fail "unsupported Vitest evidence path at $vitest_evidence_classes_registry:$line_number"
                exit 2
                ;;
        esac
        if [ -n "$previous" ] && [[ "$previous" > "$path" || "$previous" = "$path" ]]; then
            vitest_evidence_fail "Vitest evidence classes must be sorted and duplicate-free ($vitest_evidence_classes_registry:$line_number: $path)"
            exit 2
        fi
        previous="$path"
        case "$class" in
            source-only) source_count=$((source_count + 1)) ;;
            prepared-product) prepared_count=$((prepared_count + 1)) ;;
            *)
                vitest_evidence_fail "unknown Vitest evidence class at $vitest_evidence_classes_registry:$line_number"
                exit 2
                ;;
        esac
        # Report every stale row at once so one edit can fix them all.
        if [ ! -f "$root/$path" ] || [ -L "$root/$path" ]; then
            vitest_evidence_fail "stale row at $vitest_evidence_classes_registry:$line_number: $path is not a regular file. If the test was deleted, delete the row; if it was renamed, change the row to the new path and keep its class."
            stale=$((stale + 1))
            continue
        fi
        printf '%s\n' "$path" >> "$out/declared"
        printf '%s\n' "$path" >> "$out/$class"
    done < "$classes"
    if [ "$stale" -ne 0 ]; then
        vitest_evidence_fail "$stale stale row(s) in $vitest_evidence_classes_registry"
        exit 2
    fi
    if [ "$source_count" -eq 0 ] || [ "$prepared_count" -eq 0 ] ||
       [ "$((source_count + prepared_count))" -gt 1024 ]; then
        vitest_evidence_fail "Vitest evidence classes must contain a bounded two-class inventory"
        exit 2
    fi
}

# vitest_relative_paths <repo-root>
# Maps the paths Vitest prints from host/ to repository-relative paths.
vitest_relative_paths() {
    local root="$1"
    local path
    while IFS= read -r path || [ -n "${path:-}" ]; do
        case "$path" in
            test/*) printf 'host/%s\n' "$path" ;;
            ../*) printf '%s\n' "${path#../}" ;;
            "$root"/*) printf '%s\n' "${path#"$root"/}" ;;
            *)
                vitest_evidence_fail "Vitest returned an invalid evidence path: $path"
                exit 2
                ;;
        esac
    done
}

# check_vitest_evidence_coverage <repo-root> <out-dir>
# Requires read_vitest_evidence_classes output in <out-dir> and host/'s
# installed Vitest. Fails, naming each file and the side to fix, unless the
# registry and Vitest's live file inventory are the same set.
check_vitest_evidence_coverage() {
    local root="$1"
    local out="$2"
    local declared="$out/declared-sorted"
    local live_raw="$out/live-raw"
    local live="$out/live"
    local path
    local mismatches=0

    if ! (
        cd "$root/host"
        npx vitest list --filesOnly "${disabled_software_vitest_excludes[@]}"
    ) > "$live_raw"; then
        vitest_evidence_fail "could not list Vitest's file inventory from host/"
        exit 2
    fi
    vitest_relative_paths "$root" < "$live_raw" > "$live.unsorted"
    LC_ALL=C sort "$live.unsorted" > "$live"
    LC_ALL=C sort "$out/declared" > "$declared"
    if [ ! -s "$live" ]; then
        vitest_evidence_fail "Vitest listed no test files from host/"
        exit 2
    fi
    while IFS= read -r path; do
        vitest_evidence_fail "Vitest collects $path more than once"
        mismatches=$((mismatches + 1))
    done < <(LC_ALL=C uniq -d "$live")
    while IFS= read -r path; do
        vitest_evidence_fail "unclassified test: Vitest collects $path, but $vitest_evidence_classes_registry has no row for it. Add one in sorted order with class prepared-product, or source-only if source and the current ABI test fixtures are enough (docs/agent-guidance/validation.md)."
        mismatches=$((mismatches + 1))
    done < <(LC_ALL=C comm -13 "$declared" <(LC_ALL=C uniq "$live"))
    while IFS= read -r path; do
        vitest_evidence_fail "uncollected row: $vitest_evidence_classes_registry classifies $path, but CI-shaped Vitest runs do not collect it (it is excluded). Delete the row."
        mismatches=$((mismatches + 1))
    done < <(LC_ALL=C comm -23 "$declared" <(LC_ALL=C uniq "$live"))
    if [ "$mismatches" -ne 0 ]; then
        vitest_evidence_fail "Vitest evidence classes do not exactly cover the live file inventory ($mismatches mismatch(es))"
        exit 2
    fi
}

if [ "${BASH_SOURCE[0]}" = "$0" ]; then
    set -euo pipefail
    vitest_evidence_root="$(cd "$(dirname "$0")/.." && pwd)"
    vitest_evidence_out="$(mktemp -d "${TMPDIR:-/tmp}/kandelo-vitest-evidence.XXXXXX")"
    trap 'rm -rf -- "$vitest_evidence_out"' EXIT
    read_vitest_evidence_classes "$vitest_evidence_root" "$vitest_evidence_out"
    check_vitest_evidence_coverage "$vitest_evidence_root" "$vitest_evidence_out"
    echo "vitest evidence classes: $(wc -l < "$vitest_evidence_out/declared" | tr -d '[:space:]') files, registry and Vitest inventory agree"
fi
