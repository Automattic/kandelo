#!/usr/bin/env bash
set -euo pipefail

if [ "$#" -ne 4 ]; then
  echo "usage: homebrew-validate-host-dependency-plan.sh PLAN TAP FORMULA RESOLVED_TAPS" >&2
  exit 2
fi

PLAN="$1"
EXPECTED_TAP="$2"
FORMULA="$3"
RESOLVED_TAPS="$4"

jq -e --arg tap "$EXPECTED_TAP" --arg formula "$FORMULA" \
  --slurpfile resolved "$RESOLVED_TAPS" '
  . as $plan |
  keys == ["build", "build_and_test", "formula", "full_name", "native_requirements", "runtime_and_test", "schema", "tap", "target_taps"] and
  .schema == 4 and
  .tap == $tap and
  .formula == $formula and
  .full_name == ($tap + "/" + $formula) and
  (.build | type == "array") and
  (.build_and_test | type == "array") and
  (.native_requirements | type == "array" and length <= 128) and
  (.runtime_and_test | type == "array") and
  (.build == (.build | sort | unique)) and
  (.build_and_test == (.build_and_test | sort | unique)) and
  (.runtime_and_test == (.runtime_and_test | sort | unique)) and
  (.target_taps == (
    [$resolved[0].primary, $resolved[0].dependencies[]] |
    map({tap_name, tap_repository, tap_commit}) | sort_by(.tap_name)
  )) and
  (.target_taps | all(.[];
    keys == ["tap_commit", "tap_name", "tap_repository"] and
    (.tap_name | type == "string" and test("^[a-z0-9._-]+/[a-z0-9._-]+$")) and
    (.tap_repository | type == "string" and test("^[a-z0-9._-]+/homebrew-[a-z0-9._-]+$")) and
    (.tap_commit | type == "string" and test("^[0-9a-f]{40}$"))
  )) and
  (.target_taps | map(.tap_name) | index($tap) != null) and
  ((.build - .build_and_test) | length) == 0 and
  ((.runtime_and_test - .build_and_test) | length) == 0 and
  all(.build[]; type == "string" and test("^[a-z0-9][a-z0-9@+_.-]*$")) and
  all(.build_and_test[]; type == "string" and test("^[a-z0-9][a-z0-9@+_.-]*$")) and
  all(.runtime_and_test[]; type == "string" and test("^[a-z0-9][a-z0-9@+_.-]*$")) and
  (.native_requirements == (.native_requirements | sort_by(.class))) and
  ((.native_requirements | map(.class)) == (.native_requirements | map(.class) | unique)) and
  ((.native_requirements | map(.formula) | length) ==
    (.native_requirements | map(.formula) | unique | length)) and
  all(.native_requirements[];
    . as $native |
    keys == ["class", "formula", "sentinel", "tags"] and
    (.class | type == "string" and test("^KandeloFormulaSupport::[A-Z][A-Za-z0-9]*Requirement$")) and
    (.formula | type == "string" and test("^[a-z0-9][a-z0-9@+_.-]*$")) and
    (.sentinel | type == "string" and test("^[A-Za-z0-9][A-Za-z0-9._+-]*$")) and
    (.tags == ["build"] or .tags == ["build", "test"]) and
    ($plan.build | index($native.formula) != null) and
    ($plan.build_and_test | index($native.formula) != null) and
    (if $native.tags == ["build", "test"] then
       ($plan.runtime_and_test | index($native.formula) != null)
     else
       ($plan.runtime_and_test | index($native.formula) == null)
     end)
  )
' "$PLAN" >/dev/null
