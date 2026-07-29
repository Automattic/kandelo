#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd "$(dirname "$0")" && pwd)"
# shellcheck source=.github/scripts/process-memory-telemetry-scope.sh
. "$script_dir/process-memory-telemetry-scope.sh"

assert_scoped() {
  local path="$1"
  if ! printf '%s\n' "$path" |
    process_memory_telemetry_changed_files |
    grep -qxF "$path"; then
    echo "expected process-memory telemetry scope: $path" >&2
    exit 1
  fi
}

assert_unscoped() {
  local path="$1"
  if printf '%s\n' "$path" |
    process_memory_telemetry_changed_files |
    grep -qxF "$path"; then
    echo "unexpected process-memory telemetry scope: $path" >&2
    exit 1
  fi
}

for path in \
  .github/workflows/process-memory-retirement-telemetry.yml \
  .github/scripts/process-memory-telemetry-scope.sh \
  apps/browser-demos/process-memory-rss-telemetry.ts \
  apps/browser-demos/public/trap-signal-test.html \
  apps/browser-demos/package-lock.json \
  host/src/browser-kernel-worker-entry.ts \
  host/src/channel.ts \
  host/src/framebuffer/canvas-renderer.ts \
  host/src/vfs/memory-fs.ts \
  host/src/webgl/registry.ts \
  host/test/process-memory-allocator.test.ts \
  host/test/fixtures/process-memory-reclamation-churn.c \
  packages/registry/kernel/build-kernel.sh \
  scripts/build-musl.sh \
  package-lock.json
do
  assert_scoped "$path"
done

for path in \
  docs/architecture.md \
  host/src/node-kernel-host.ts \
  apps/browser-demos/pages/gallery.tsx
do
  assert_unscoped "$path"
done

if printf '' | process_memory_telemetry_changed_files | grep -q .; then
  echo "empty path input unexpectedly required telemetry" >&2
  exit 1
fi
if (
  grep() { return 2; }
  printf '%s\n' host/src/process-memory.ts |
    process_memory_telemetry_changed_files
); then
  echo "scope matcher swallowed a grep failure" >&2
  exit 1
fi

run_gate() {
  TELEMETRY_REQUIRED="$1" \
    SCOPE_RESULT="$2" \
    PREPARE_RESULT="$3" \
    MEASURE_RESULT="$4" \
    bash "$script_dir/process-memory-telemetry-gate.sh"
}

run_gate true success success success >/dev/null
run_gate false success skipped skipped >/dev/null

if run_gate true success success failure >/dev/null 2>&1; then
  echo "failed required measurement unexpectedly passed" >&2
  exit 1
fi
if run_gate false failure skipped skipped >/dev/null 2>&1; then
  echo "failed scope job unexpectedly passed" >&2
  exit 1
fi
if run_gate false success success skipped >/dev/null 2>&1; then
  echo "out-of-scope preparation unexpectedly passed" >&2
  exit 1
fi

workflow="$script_dir/../workflows/process-memory-retirement-telemetry.yml"
# These are intentionally literal GitHub expressions.
# shellcheck disable=SC2016
grep -Fq 'ref: ${{ github.event.pull_request.head.sha || github.sha }}' \
  "$workflow"
# shellcheck disable=SC2016
grep -Fq 'ref: ${{ needs.scope.outputs.target_sha }}' "$workflow"
# shellcheck disable=SC2016
grep -Fq 'changed_files="$(git diff --name-only "$BASE_SHA...HEAD")"' \
  "$workflow"
# shellcheck disable=SC2016
grep -Fq 'EXPECTED_SHA: ${{ needs.scope.outputs.target_sha }}' "$workflow"
grep -Fq 'if: always()' "$workflow"

echo "process-memory telemetry control tests passed"
