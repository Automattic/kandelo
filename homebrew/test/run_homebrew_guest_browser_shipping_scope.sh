#!/usr/bin/env bash
set -euo pipefail

if (( $# != 1 )); then
  echo "usage: $0 <core|canary>" >&2
  exit 2
fi

scope="$1"
case "$scope" in
  core|canary) ;;
  *)
    echo "unsupported Homebrew browser shipping scope: $scope" >&2
    exit 2
    ;;
esac

: "${KANDELO_HOMEBREW_GUEST_BROWSER_LIFECYCLE_FIXTURE_PATH:?missing fixture}"
: "${RUNNER_TEMP:?missing runner temporary directory}"

repo_root="$(cd "$(dirname "$0")/../.." && pwd)"
browser_runtime_root="${KANDELO_HOMEBREW_BROWSER_RUNTIME_ROOT:-}"
if [[ -n "$browser_runtime_root" ]]; then
  browser_workdir="$browser_runtime_root/browser"
  if [[ ! -d "$browser_workdir" || -L "$browser_workdir" ]]; then
    echo "invalid Homebrew browser runtime root: $browser_runtime_root" >&2
    exit 1
  fi
  playwright_args=(
    --config playwright.config.ts
    --project=chromium
    --grep "selected stock Homebrew shipping scope"
    --reporter=json
  )
else
  browser_workdir="$repo_root/apps/browser-demos"
  playwright_args=(
    test/homebrew-guest-lifecycle.spec.ts
    --project=chromium
    --grep "selected stock Homebrew shipping scope"
    --reporter=json
  )
fi
telemetry="$RUNNER_TEMP/homebrew-chromium-lifecycle-resources.log"
playwright_log="$RUNNER_TEMP/homebrew-chromium-playwright.log"
playwright_log_raw="$RUNNER_TEMP/homebrew-chromium-playwright.raw.log"
playwright_report="$RUNNER_TEMP/homebrew-chromium-playwright.json"
cgroup_path="$(
  awk -F: '$1 == "0" { print $3; exit }' \
    /proc/self/cgroup 2>/dev/null || true
)"
cgroup_root="/sys/fs/cgroup${cgroup_path:-/}"
memory_events_path="$cgroup_root/memory.events"
if [[ ! -r "$memory_events_path" ]]; then
  echo "cgroup memory events are unavailable: $memory_events_path" >&2
  exit 1
fi
touch "$telemetry"

memory_event_value() {
  local name="$1"
  awk -v name="$name" '$1 == name { print $2; found = 1 } END {
    if (!found) print 0
  }' "$memory_events_path"
}

baseline_oom="$(memory_event_value oom)"
baseline_oom_kill="$(memory_event_value oom_kill)"

sample_resources() {
  local current peak events process_rows
  local chromium_count chromium_rss_kib aggregate_rss_kib
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
  aggregate_rss_kib="$(
    ps -e -o rss= |
      awk '{ sum += $1 } END { print sum + 0 }'
  )"
  process_rows="$(mktemp)"
  ps -e -o pid=,ppid=,rss=,comm=,args= |
    awk '
      $4 ~ /^(chrome|chromium|headless_shell|chrome_crashpad)$/ {
        type = "browser"
        for (field = 5; field <= NF; field += 1) {
          if ($field ~ /^--type=/) {
            type = $field
            sub(/^--type=/, "", type)
          }
        }
        print $1, $2, $3, type
      }
    ' >"$process_rows"
  chromium_count="$(wc -l <"$process_rows" | tr -d '[:space:]')"
  chromium_rss_kib="$(
    awk '{ sum += $3 } END { print sum + 0 }' "$process_rows"
  )"
  printf \
    '%s scope=%s cgroup_current_bytes=%s cgroup_peak_bytes=%s aggregate_rss_kib=%s chromium_count=%s chromium_rss_kib=%s memory_events=%s\n' \
    "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
    "$scope" "$current" "$peak" "$aggregate_rss_kib" \
    "$chromium_count" "$chromium_rss_kib" "$events" |
    tee -a "$telemetry"
  while read -r pid ppid rss_kib type; do
    printf \
      '%s scope=%s chromium_pid=%s ppid=%s rss_kib=%s type=%s\n' \
      "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
      "$scope" "$pid" "$ppid" "$rss_kib" "$type" >>"$telemetry"
  done <"$process_rows"
  rm -f "$process_rows"
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
printf '%s scope=%s baseline_oom=%s baseline_oom_kill=%s\n' \
  "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
  "$scope" "$baseline_oom" "$baseline_oom_kill" |
  tee -a "$telemetry"
sample_resources
(
  # WHY: a fixed sample count covers the complete proof deadline without
  # allowing a stuck browser to create an unbounded diagnostics artifact.
  for ((sample = 0; sample < 96; sample += 1)); do
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

scope_exit_code=0
set +e
(
  cd "$browser_workdir"
  # WHY: Playwright starts both Chromium and the sealed web server. Remove
  # Actions credentials at their common parent so future transport changes
  # cannot accidentally turn this anonymous proof into an authenticated one.
  env -u GH_TOKEN -u GITHUB_TOKEN \
    DEBUG=pw:browser \
    KANDELO_BROWSER_DEMO_INPUTS=main \
    KANDELO_PLAYWRIGHT_SERVE_DIST=1 \
    KANDELO_HOMEBREW_GUEST_BROWSER_LIFECYCLE_LIVE=1 \
    KANDELO_HOMEBREW_GUEST_BROWSER_SHIPPING_SCOPE="$scope" \
    PLAYWRIGHT_JSON_OUTPUT_FILE="$playwright_report" \
    npx playwright test "${playwright_args[@]}"
) 2>&1 | tee "$playwright_log_raw"
scope_exit_code="${PIPESTATUS[0]}"
set -e

# Preserve a bounded tail even if Chromium or Playwright emits an unexpectedly
# large diagnostic stream. The workflow log already received live progress.
tail -c $((2 * 1024 * 1024)) "$playwright_log_raw" >"$playwright_log"
rm -f "$playwright_log_raw"

record_scope_state finished " exit_code=$scope_exit_code"
trap - EXIT
stop_telemetry

final_oom="$(memory_event_value oom)"
final_oom_kill="$(memory_event_value oom_kill)"
printf '%s scope=%s final_oom=%s final_oom_kill=%s\n' \
  "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
  "$scope" "$final_oom" "$final_oom_kill" |
  tee -a "$telemetry"
# WHY: a renderer can disappear without leaving a useful Playwright error.
# The proof is not green if its own cgroup attempted or performed an OOM kill,
# even if browser teardown later lets the command return successfully.
if (( final_oom > baseline_oom || final_oom_kill > baseline_oom_kill )); then
  record_scope_state cgroup-oom \
    " baseline_oom=$baseline_oom final_oom=$final_oom baseline_oom_kill=$baseline_oom_kill final_oom_kill=$final_oom_kill"
  scope_exit_code=1
fi
exit "$scope_exit_code"
