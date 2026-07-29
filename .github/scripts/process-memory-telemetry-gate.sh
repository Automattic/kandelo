#!/usr/bin/env bash
set -euo pipefail

scope_result="${SCOPE_RESULT:-missing}"

if [[ "$scope_result" != "success" ]]; then
  echo "scope job did not succeed: $scope_result" >&2
  exit 1
fi

required="${TELEMETRY_REQUIRED:-missing}"
prepare_result="${PREPARE_RESULT:-missing}"
measure_result="${MEASURE_RESULT:-missing}"

case "$required" in
  false)
    if [[ "$prepare_result" != "skipped" || "$measure_result" != "skipped" ]]; then
      echo "out-of-scope telemetry unexpectedly ran" >&2
      exit 1
    fi
    echo "Process-memory telemetry is not applicable to this change."
    ;;
  true)
    if [[ "$prepare_result" != "success" || "$measure_result" != "success" ]]; then
      echo "required process-memory telemetry did not pass" >&2
      echo "prepare=$prepare_result measure=$measure_result" >&2
      exit 1
    fi
    echo "All required process-memory telemetry jobs passed."
    ;;
  *)
    echo "invalid telemetry requirement: $required" >&2
    exit 1
    ;;
esac
