#!/usr/bin/env bash
set -euo pipefail

report="${1:-}"
expected_abi="${2:-}"
if [ -z "$report" ] || [ -z "$expected_abi" ] || [ "$#" -ne 2 ]; then
    echo "usage: $0 <publication-blockers.json> <expected-abi>" >&2
    exit 2
fi
if [ ! -f "$report" ] || [ -L "$report" ]; then
    echo "validate-publication-blocker-report: report must be a regular non-symlink file: $report" >&2
    exit 1
fi
if ! [[ "$expected_abi" =~ ^[0-9]+$ ]]; then
    echo "validate-publication-blocker-report: expected ABI must be an integer" >&2
    exit 2
fi

jq -e --argjson abi "$expected_abi" '
  type == "object" and
  keys == ["abi_version", "entries"] and
  .abi_version == $abi and
  (.entries | type) == "array" and
  ([.entries[].package] | length) ==
    ([.entries[].package] | unique | length) and
  all(.entries[];
    type == "object" and
    keys == ["blocker_chain", "package"] and
    (.package | type) == "string" and
    (.package | test("^[a-z0-9][a-z0-9+._-]*$")) and
    (.blocker_chain | type) == "array" and
    (.blocker_chain | length) > 0 and
    .blocker_chain[0] == .package and
    all(.blocker_chain[];
      type == "string" and
      test("^[a-z0-9][a-z0-9+._-]*$")
    )
  )
' "$report" >/dev/null || {
    echo "validate-publication-blocker-report: malformed or ABI-mismatched report" >&2
    exit 1
}
