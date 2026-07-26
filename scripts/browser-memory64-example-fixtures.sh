#!/usr/bin/env bash

# Shared, fail-closed reader for browser-memory64-example-fixtures.txt.
#
# Callers set both variables before sourcing this file:
#   BROWSER_MEMORY64_FIXTURES_REPO_ROOT
#   BROWSER_MEMORY64_FIXTURES_MANIFEST

browser_memory64_fixture_sources() {
    if [ -z "${BROWSER_MEMORY64_FIXTURES_REPO_ROOT:-}" ]; then
        echo "browser memory64 fixtures: repository root is not configured" >&2
        return 1
    fi
    if [ -z "${BROWSER_MEMORY64_FIXTURES_MANIFEST:-}" ] ||
        [ ! -f "$BROWSER_MEMORY64_FIXTURES_MANIFEST" ]; then
        echo "browser memory64 fixtures: manifest is missing: ${BROWSER_MEMORY64_FIXTURES_MANIFEST:-<unset>}" >&2
        return 1
    fi

    local count=0
    local leaf
    local line
    local previous=""
    while IFS= read -r line || [ -n "$line" ]; do
        case "$line" in
            ""|\#*) continue ;;
            examples/*.c) ;;
            *)
                echo "browser memory64 fixtures: invalid source path: $line" >&2
                return 1
                ;;
        esac
        leaf="${line#examples/}"
        leaf="${leaf%.c}"
        case "$leaf" in
            ""|*/*|*[!a-z0-9_-]*)
                echo "browser memory64 fixtures: invalid source path: $line" >&2
                return 1
                ;;
        esac
        if [ -n "$previous" ] &&
            { [ "$line" = "$previous" ] || [[ "$line" < "$previous" ]]; }; then
            echo "browser memory64 fixtures: manifest must be sorted with no duplicates" >&2
            return 1
        fi
        if [ ! -f "$BROWSER_MEMORY64_FIXTURES_REPO_ROOT/$line" ]; then
            echo "browser memory64 fixtures: source is missing: $line" >&2
            return 1
        fi
        printf '%s\n' "$line"
        previous="$line"
        count=$((count + 1))
    done < "$BROWSER_MEMORY64_FIXTURES_MANIFEST"

    if [ "$count" -eq 0 ]; then
        echo "browser memory64 fixtures: manifest has no sources" >&2
        return 1
    fi
}

browser_memory64_fixture_outputs() {
    local source
    local sources
    sources="$(browser_memory64_fixture_sources)" || return 1
    while IFS= read -r source; do
        printf '%s.wasm64.wasm\n' "${source%.c}"
    done <<< "$sources"
}
