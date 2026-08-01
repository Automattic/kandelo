#!/usr/bin/env bash
# Split one exact staging matrix from the complete package ledger.
#
# The selected rows must come from the sealed PR release. Every other row may
# come only from the separately verified canonical release. Keeping the split
# explicit prevents a missing PR archive from silently falling back to older
# canonical bytes.
set -euo pipefail

EXPECTED_LEDGER=""
SELECTED_MATRIX=""
SELECTED_OUTPUT=""
COMPLEMENT_OUTPUT=""

while [ "$#" -gt 0 ]; do
  case "$1" in
    --expected-ledger) EXPECTED_LEDGER="$2"; shift 2 ;;
    --selected-matrix) SELECTED_MATRIX="$2"; shift 2 ;;
    --selected-output) SELECTED_OUTPUT="$2"; shift 2 ;;
    --complement-output) COMPLEMENT_OUTPUT="$2"; shift 2 ;;
    *)
      echo "split-staging-package-ledger: unknown flag $1" >&2
      exit 2
      ;;
  esac
done

if [ ! -f "$EXPECTED_LEDGER" ] || [ ! -f "$SELECTED_MATRIX" ] ||
   [ -z "$SELECTED_OUTPUT" ] || [ -z "$COMPLEMENT_OUTPUT" ] ||
   [ "$SELECTED_OUTPUT" = "$COMPLEMENT_OUTPUT" ] ||
   [ -e "$SELECTED_OUTPUT" ] || [ -e "$COMPLEMENT_OUTPUT" ]; then
  echo "split-staging-package-ledger: distinct new outputs and input files are required" >&2
  exit 2
fi

selected_parent="$(dirname "$SELECTED_OUTPUT")"
complement_parent="$(dirname "$COMPLEMENT_OUTPUT")"
[ -d "$selected_parent" ] && [ -d "$complement_parent" ] || {
  echo "split-staging-package-ledger: output parents must already exist" >&2
  exit 2
}

jq -e '
  type == "object" and
  (.abi_version | type == "number" and . >= 0 and floor == .) and
  (.entries | type == "array" and length > 0) and
  all(.entries[];
    type == "object" and
    (.package | type == "string" and
      test("^[a-z0-9][a-z0-9._-]*$")) and
    (.arch == "wasm32" or .arch == "wasm64") and
    (.version | type == "string" and length > 0) and
    (.revision | type == "number" and . >= 0 and floor == .) and
    (.cache_key_sha | type == "string" and test("^[0-9a-f]{64}$"))) and
  ([.entries[] | .package + "\u0000" + .arch] |
    length == (unique | length))
' "$EXPECTED_LEDGER" >/dev/null || {
  echo "split-staging-package-ledger: expected ledger is invalid or ambiguous" >&2
  exit 1
}

jq -e '
  type == "array" and length > 0 and
  all(.[];
    type == "object" and
    (keys | sort) == ["arch", "package", "revision", "sha", "version"] and
    (.package | type == "string" and
      test("^[a-z0-9][a-z0-9._-]*$")) and
    (.arch == "wasm32" or .arch == "wasm64") and
    (.version | type == "string" and length > 0) and
    (.revision | type == "number" and . >= 0 and floor == .) and
    (.sha | type == "string" and test("^[0-9a-f]{64}$"))) and
  ([.[] | .package + "\u0000" + .arch] |
    length == (unique | length))
' "$SELECTED_MATRIX" >/dev/null || {
  echo "split-staging-package-ledger: selected matrix is invalid or ambiguous" >&2
  exit 1
}

# WHY: the workflow output is an orchestration hint, not package authority.
# Rebind every selected row to the ledger derived from the reviewed checkout
# before it can decide which release supplies executable bytes.
jq -e --slurpfile selected "$SELECTED_MATRIX" '
  .entries as $expected |
  all($selected[0][];
    . as $row |
    any($expected[];
      .package == $row.package and
      .arch == $row.arch and
      .version == $row.version and
      .revision == $row.revision and
      .cache_key_sha == $row.sha))
' "$EXPECTED_LEDGER" >/dev/null || {
  echo "split-staging-package-ledger: selected matrix differs from the reviewed ledger" >&2
  exit 1
}

tmp_root="$(mktemp -d "$selected_parent/.staging-ledger-split.XXXXXX")"
trap 'rm -rf "$tmp_root"' EXIT

jq --slurpfile selected "$SELECTED_MATRIX" '
  .entries |= map(. as $entry |
    select(any($selected[0][];
      .package == $entry.package and .arch == $entry.arch)))
' "$EXPECTED_LEDGER" > "$tmp_root/selected.json"

jq --slurpfile selected "$SELECTED_MATRIX" '
  .entries |= map(. as $entry |
    select(all($selected[0][];
      .package != $entry.package or .arch != $entry.arch)))
' "$EXPECTED_LEDGER" > "$tmp_root/complement.json"

selected_count="$(jq '.entries | length' "$tmp_root/selected.json")"
matrix_count="$(jq 'length' "$SELECTED_MATRIX")"
full_count="$(jq '.entries | length' "$EXPECTED_LEDGER")"
complement_count="$(jq '.entries | length' "$tmp_root/complement.json")"
if [ "$selected_count" -ne "$matrix_count" ] ||
   [ $((selected_count + complement_count)) -ne "$full_count" ]; then
  echo "split-staging-package-ledger: selected rows do not partition the complete ledger" >&2
  exit 1
fi

mv "$tmp_root/selected.json" "$SELECTED_OUTPUT"
mv "$tmp_root/complement.json" "$COMPLEMENT_OUTPUT"
trap - EXIT
rm -rf "$tmp_root"

echo "split-staging-package-ledger: selected $selected_count of $full_count entries"
