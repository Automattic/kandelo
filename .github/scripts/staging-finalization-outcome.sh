#!/usr/bin/env bash
# Reduce GitHub job results to the staging publication/test state machine.
set -euo pipefail

MATRIX_SELECTED=""
LIBRARY_RESULT=""
PROGRAM_RESULT=""
FINALIZER_RESULT=""
HAD_FAILURES=""
OUTPUT=""

while [ "$#" -gt 0 ]; do
  case "$1" in
    --matrix-selected) MATRIX_SELECTED="$2"; shift 2 ;;
    --library-result) LIBRARY_RESULT="$2"; shift 2 ;;
    --program-result) PROGRAM_RESULT="$2"; shift 2 ;;
    --finalizer-result) FINALIZER_RESULT="$2"; shift 2 ;;
    --had-failures) HAD_FAILURES="$2"; shift 2 ;;
    --output) OUTPUT="$2"; shift 2 ;;
    *) echo "staging-finalization-outcome: unknown flag $1" >&2; exit 2 ;;
  esac
done

valid_job_result() {
  case "$1" in
    success|failure|skipped|cancelled) return 0 ;;
    *) return 1 ;;
  esac
}

if [[ "$MATRIX_SELECTED" != true && "$MATRIX_SELECTED" != false ]] ||
   ! valid_job_result "$LIBRARY_RESULT" ||
   ! valid_job_result "$PROGRAM_RESULT" ||
   ! valid_job_result "$FINALIZER_RESULT" ||
   [ -z "$OUTPUT" ] || [ "$OUTPUT" = / ]; then
  echo "staging-finalization-outcome: valid selection, job results, and output are required" >&2
  exit 2
fi
if [[ "$HAD_FAILURES" != 0 && "$HAD_FAILURES" != 1 && -n "$HAD_FAILURES" ]]; then
  echo "staging-finalization-outcome: had-failures must be 0, 1, or empty" >&2
  exit 2
fi

publication_succeeded=false
finalization_ready=false
test_ready=false
artifact_failures=false
reason=""

if [ "$MATRIX_SELECTED" = true ]; then
  if [ "$FINALIZER_RESULT" = success ]; then
    [ -n "$HAD_FAILURES" ] || {
      echo "staging-finalization-outcome: successful finalizer lacks had-failures output" >&2
      exit 1
    }
    publication_succeeded=true
    finalization_ready=true
  else
    reason="staging snapshot publication did not succeed"
  fi

  if [ "$LIBRARY_RESULT" = failure ] || [ "$PROGRAM_RESULT" = failure ] ||
     [ "$HAD_FAILURES" = 1 ]; then
    artifact_failures=true
  fi
  if [ "$LIBRARY_RESULT" = cancelled ] || [ "$PROGRAM_RESULT" = cancelled ]; then
    finalization_ready=false
    reason="a package matrix wave was cancelled"
  fi
else
  # WHY: zero-build reuse and runtime-only PRs legitimately skip all three
  # package jobs. Treat only that exact shape as ready; a hidden finalizer or
  # matrix failure must not be mistaken for a no-op package run.
  if [ "$LIBRARY_RESULT" = skipped ] &&
     [ "$PROGRAM_RESULT" = skipped ] &&
     [ "$FINALIZER_RESULT" = skipped ]; then
    finalization_ready=true
  else
    reason="zero-matrix staging jobs did not all skip"
  fi
fi

if [ "$finalization_ready" = true ]; then
  test_ready=true
fi

jq -n \
  --argjson matrix_selected "$MATRIX_SELECTED" \
  --argjson publication_succeeded "$publication_succeeded" \
  --argjson finalization_ready "$finalization_ready" \
  --argjson test_ready "$test_ready" \
  --argjson artifact_failures "$artifact_failures" \
  --arg had_failures "${HAD_FAILURES:-0}" \
  --arg reason "$reason" \
  '{
    matrix_selected: $matrix_selected,
    publication_succeeded: $publication_succeeded,
    finalization_ready: $finalization_ready,
    test_ready: $test_ready,
    artifact_failures: $artifact_failures,
    had_failures: ($had_failures | tonumber),
    reason: $reason
  }' >"$OUTPUT"
