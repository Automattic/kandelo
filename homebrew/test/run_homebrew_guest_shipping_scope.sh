#!/usr/bin/env bash
set -euo pipefail

if (( $# != 1 )); then
  echo "usage: $0 <shipping-core|shipping-canary>" >&2
  exit 2
fi

scope="$1"
case "$scope" in
  shipping-core|shipping-canary) ;;
  *)
    echo "unsupported Homebrew shipping scope: $scope" >&2
    exit 2
    ;;
esac

: "${IMAGE:?missing public Homebrew image}"
: "${BOOTSTRAP:?missing public Homebrew bootstrap archive}"
: "${BOOTSTRAP_ENV:?missing public Homebrew bootstrap environment}"
: "${TAP_CATALOG_REF:?missing sealed tap catalog revision}"
: "${CANARY_REF:?missing canary revision}"
: "${RUNNER_TEMP:?missing runner temporary directory}"

telemetry="$RUNNER_TEMP/homebrew-node-lifecycle-resources.log"
touch "$telemetry"

sample_resources() {
  local cgroup_path cgroup_root current peak events rss_kib disk_kib
  cgroup_path="$(
    awk -F: '$1 == "0" { print $3; exit }' \
      /proc/self/cgroup 2>/dev/null || true
  )"
  cgroup_root="/sys/fs/cgroup${cgroup_path:-/}"
  current="$(
    cat "$cgroup_root/memory.current" 2>/dev/null ||
      printf unavailable
  )"
  peak="$(
    cat "$cgroup_root/memory.peak" 2>/dev/null ||
      printf unavailable
  )"
  events="$(
    tr '\n' ',' <"$cgroup_root/memory.events" 2>/dev/null ||
      printf unavailable
  )"
  rss_kib="$(ps -e -o rss= | awk '{ sum += $1 } END { print sum + 0 }')"
  disk_kib="$(
    df -Pk "$RUNNER_TEMP" |
      awk 'NR == 2 { print $4; exit }'
  )"
  printf \
    '%s scope=%s cgroup_current_bytes=%s cgroup_peak_bytes=%s aggregate_rss_kib=%s disk_available_kib=%s memory_events=%s\n' \
    "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
    "$scope" "$current" "$peak" "$rss_kib" "$disk_kib" "$events" |
    tee -a "$telemetry"
}

record_scope_state() {
  local state="$1"
  local scope_result="${2:-}"
  printf '%s scope=%s state=%s%s\n' \
    "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
    "$scope" "$state" "$scope_result" |
    tee -a "$telemetry"
}

record_scope_state started
sample_resources
(
  # WHY: a fixed sample count preserves diagnostics for a full scope deadline
  # without allowing a stalled proof to create an unbounded log.
  for ((sample = 0; sample < 64; sample += 1)); do
    sleep 15
    sample_resources
  done
) &
telemetry_pid=$!
stop_telemetry() {
  kill "$telemetry_pid" 2>/dev/null || true
  wait "$telemetry_pid" 2>/dev/null || true
  sample_resources
}
trap stop_telemetry EXIT

# WHY: each invocation owns one workflow step and one Node process. A cancelled
# run therefore retains which fresh-image scope had begun in workflow metadata.
# The shipping proof limits work to first- and third-party bottle execution;
# comprehensive reinstall, cleanup, export, and reboot have a separate gate.
scope_exit_code=0
bash scripts/dev-shell.sh npx tsx \
  homebrew/test/homebrew_guest_lifecycle_node.ts \
    --image "$IMAGE" \
    --homebrew-bootstrap-spec \
      homebrew/main-shell-brew-package-tree.json \
    --homebrew-bootstrap-archive "$BOOTSTRAP" \
    --homebrew-bootstrap-env "$BOOTSTRAP_ENV" \
    --transport-mode public \
    --proof-mode "$scope" \
    --core-revision "$TAP_CATALOG_REF" \
    --canary-revision "$CANARY_REF" \
    --timeout-ms 900000 ||
  scope_exit_code=$?

record_scope_state finished " exit_code=$scope_exit_code"
trap - EXIT
stop_telemetry
exit "$scope_exit_code"
