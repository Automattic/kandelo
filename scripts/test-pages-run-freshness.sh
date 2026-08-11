#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
CHECKER="$REPO_ROOT/scripts/check-pages-run-freshness.sh"
FIXTURE_ROOT="$(mktemp -d "${TMPDIR:-/tmp}/kandelo-pages-runs.XXXXXX")"
BIN_DIR="$FIXTURE_ROOT/bin"
mkdir -p "$BIN_DIR"

cleanup() {
  case "$FIXTURE_ROOT" in
    "${TMPDIR:-/tmp}"/kandelo-pages-runs.*)
      rm -rf -- "$FIXTURE_ROOT"
      ;;
  esac
}
trap cleanup EXIT

fail() {
  echo "test-pages-run-freshness: $*" >&2
  exit 1
}

cat >"$BIN_DIR/gh" <<'SH'
#!/usr/bin/env bash
set -euo pipefail

workflow_file="${PAGES_WORKFLOW_FILE:-browser-demos-pages.yml}"
expected="api --method GET /repos/Automattic/kandelo/actions/workflows/${workflow_file}/runs -f branch=main -f per_page=100"
[ "$*" = "$expected" ] || {
  echo "fake gh: unexpected arguments: $*" >&2
  exit 64
}
if [ "${FAKE_GH_FAIL:-false}" = true ]; then
  echo "fake gh: simulated API failure" >&2
  exit 22
fi
printf '%s\n' "${FAKE_GH_RESPONSE:?FAKE_GH_RESPONSE is required}"
SH
chmod +x "$BIN_DIR/gh"

run_checker() {
  local response="$1"
  local output_file="$2"
  : >"$output_file"
  env \
    PATH="$BIN_DIR:$PATH" \
    GH_TOKEN=test-token \
    GITHUB_REPOSITORY=Automattic/kandelo \
    GITHUB_RUN_ID=100 \
    GITHUB_RUN_NUMBER=7 \
    GITHUB_OUTPUT="$output_file" \
    FAKE_GH_RESPONSE="$response" \
    bash "$CHECKER"
}

run_canary_checker() {
  local response="$1"
  local output_file="$2"
  : >"$output_file"
  env \
    PATH="$BIN_DIR:$PATH" \
    GH_TOKEN=test-token \
    GITHUB_REPOSITORY=Automattic/kandelo \
    GITHUB_RUN_ID=100 \
    GITHUB_RUN_NUMBER=7 \
    GITHUB_SHA=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa \
    GITHUB_REF=refs/heads/main \
    GITHUB_EVENT_NAME=push \
    GITHUB_WORKFLOW_REF=Automattic/kandelo/.github/workflows/abi-staging-pages-canary.yml@refs/heads/main \
    GITHUB_OUTPUT="$output_file" \
    PAGES_WORKFLOW_FILE=abi-staging-pages-canary.yml \
    FAKE_GH_RESPONSE="$response" \
    bash "$CHECKER"
}

current_response='{"workflow_runs":[
  {"id":100,"run_number":7,"head_branch":"main"},
  {"id":99,"run_number":6,"head_branch":"main"}
]}'
run_checker "$current_response" "$FIXTURE_ROOT/current.out" >/dev/null
grep -Fxq 'publish=true' "$FIXTURE_ROOT/current.out" ||
  fail "the newest run was not authorized"

newer_response='{"workflow_runs":[
  {"id":101,"run_number":8,"head_branch":"main"},
  {"id":100,"run_number":7,"head_branch":"main"}
]}'
run_checker "$newer_response" "$FIXTURE_ROOT/newer.out" >/dev/null
grep -Fxq 'publish=false' "$FIXTURE_ROOT/newer.out" ||
  fail "a run with a newer triggered successor was not skipped"

if FAKE_GH_FAIL=true \
  FAKE_GH_RESPONSE="$current_response" \
  PATH="$BIN_DIR:$PATH" \
  GH_TOKEN=test-token \
  GITHUB_REPOSITORY=Automattic/kandelo \
  GITHUB_RUN_ID=100 \
  GITHUB_RUN_NUMBER=7 \
  GITHUB_OUTPUT="$FIXTURE_ROOT/api-error.out" \
  bash "$CHECKER" >"$FIXTURE_ROOT/api-error.log" 2>&1; then
  fail "an API failure authorized publication"
fi
grep -Fq 'workflow-runs API request failed' "$FIXTURE_ROOT/api-error.log" ||
  fail "the API failure was not explicit"

if run_checker '{"workflow_runs":[]}' "$FIXTURE_ROOT/empty.out" \
  >"$FIXTURE_ROOT/empty.log" 2>&1; then
  fail "an empty API response authorized publication"
fi
grep -Fq 'empty or malformed' "$FIXTURE_ROOT/empty.log" ||
  fail "the empty-response failure was not explicit"

if run_checker \
  '{"workflow_runs":[{"id":100,"run_number":7.5,"head_branch":"main"}]}' \
  "$FIXTURE_ROOT/malformed.out" \
  >"$FIXTURE_ROOT/malformed.log" 2>&1; then
  fail "malformed workflow-run metadata authorized publication"
fi
grep -Fq 'empty or malformed' "$FIXTURE_ROOT/malformed.log" ||
  fail "the malformed-response failure was not explicit"

if run_checker \
  '{"workflow_runs":[{"id":99,"run_number":6,"head_branch":"main"}]}' \
  "$FIXTURE_ROOT/missing-current.out" \
  >"$FIXTURE_ROOT/missing-current.log" 2>&1; then
  fail "an API response missing the current run authorized publication"
fi
grep -Fq 'current workflow run 100 is missing' "$FIXTURE_ROOT/missing-current.log" ||
  fail "the missing-current-run failure was not explicit"

if run_checker \
  '{"workflow_runs":[{"id":100,"run_number":8,"head_branch":"main"}]}' \
  "$FIXTURE_ROOT/mismatched-current.out" \
  >"$FIXTURE_ROOT/mismatched-current.log" 2>&1; then
  fail "a mismatched current run number authorized publication"
fi
grep -Fq 'current run number does not match' \
  "$FIXTURE_ROOT/mismatched-current.log" ||
  fail "the mismatched-current-run failure was not explicit"

canary_current_response='{"workflow_runs":[
  {"id":100,"run_number":7,"head_branch":"main","head_sha":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","event":"push","path":".github/workflows/abi-staging-pages-canary.yml"},
  {"id":99,"run_number":6,"head_branch":"main","head_sha":"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb","event":"push","path":".github/workflows/abi-staging-pages-canary.yml"}
]}'
run_canary_checker "$canary_current_response" \
  "$FIXTURE_ROOT/canary-current.out" >/dev/null
grep -Fxq 'upload=true' "$FIXTURE_ROOT/canary-current.out" ||
  fail "the exact newest canary run was not authorized for inert upload"
if grep -Fq 'publish=' "$FIXTURE_ROOT/canary-current.out"; then
  fail "the canary freshness guard wrote production publication intent"
fi

canary_newer_response='{"workflow_runs":[
  {"id":101,"run_number":8,"head_branch":"main","head_sha":"cccccccccccccccccccccccccccccccccccccccc","event":"push","path":".github/workflows/abi-staging-pages-canary.yml"},
  {"id":100,"run_number":7,"head_branch":"main","head_sha":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","event":"push","path":".github/workflows/abi-staging-pages-canary.yml"}
]}'
run_canary_checker "$canary_newer_response" \
  "$FIXTURE_ROOT/canary-newer.out" >/dev/null
grep -Fxq 'upload=false' "$FIXTURE_ROOT/canary-newer.out" ||
  fail "a canary with a newer triggered successor was not skipped"

expect_canary_rejected() {
  local label="$1"
  local expected_error="$2"
  local response="$3"
  shift 3
  local output="$FIXTURE_ROOT/canary-rejected-${label}.out"
  local log="$FIXTURE_ROOT/canary-rejected-${label}.log"
  if env \
      PATH="$BIN_DIR:$PATH" \
      GH_TOKEN=test-token \
      GITHUB_REPOSITORY=Automattic/kandelo \
      GITHUB_RUN_ID=100 \
      GITHUB_RUN_NUMBER=7 \
      GITHUB_SHA=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa \
      GITHUB_REF=refs/heads/main \
      GITHUB_EVENT_NAME=push \
      GITHUB_WORKFLOW_REF=Automattic/kandelo/.github/workflows/abi-staging-pages-canary.yml@refs/heads/main \
      GITHUB_OUTPUT="$output" \
      PAGES_WORKFLOW_FILE=abi-staging-pages-canary.yml \
      FAKE_GH_RESPONSE="$response" \
      "$@" \
      bash "$CHECKER" >"$log" 2>&1; then
    fail "the canary freshness guard accepted $label"
  fi
  grep -Fq "$expected_error" "$log" ||
    fail "the canary freshness guard rejected $label unexpectedly: $(cat "$log")"
}

expect_canary_rejected \
  "foreign-repository" \
  "canary requires protected repository Automattic/kandelo" \
  "$canary_current_response" \
  GITHUB_REPOSITORY=Elsewhere/kandelo

expect_canary_rejected \
  "non-main-ref" \
  "canary requires one protected main push" \
  "$canary_current_response" \
  GITHUB_REF=refs/heads/release

expect_canary_rejected \
  "manual-event" \
  "canary requires one protected main push" \
  "$canary_current_response" \
  GITHUB_EVENT_NAME=workflow_dispatch

expect_canary_rejected \
  "foreign-workflow-ref" \
  "canary requires its protected workflow ref" \
  "$canary_current_response" \
  GITHUB_WORKFLOW_REF=Automattic/kandelo/.github/workflows/browser-demos-pages.yml@refs/heads/main

expect_canary_rejected \
  "foreign-current-sha" \
  "current canary run differs from its exact event source" \
  '{"workflow_runs":[{"id":100,"run_number":7,"head_branch":"main","head_sha":"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb","event":"push","path":".github/workflows/abi-staging-pages-canary.yml"}]}'

expect_canary_rejected \
  "foreign-current-event" \
  "workflow-runs API response is empty or malformed" \
  '{"workflow_runs":[{"id":100,"run_number":7,"head_branch":"main","head_sha":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","event":"workflow_dispatch","path":".github/workflows/abi-staging-pages-canary.yml"}]}'

expect_canary_rejected \
  "foreign-current-workflow" \
  "workflow-runs API response is empty or malformed" \
  '{"workflow_runs":[{"id":100,"run_number":7,"head_branch":"main","head_sha":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","event":"push","path":".github/workflows/browser-demos-pages.yml"}]}'

expect_canary_rejected \
  "duplicate-current-run" \
  "current workflow run 100 is missing or duplicated" \
  '{"workflow_runs":[{"id":100,"run_number":7,"head_branch":"main","head_sha":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","event":"push","path":".github/workflows/abi-staging-pages-canary.yml"},{"id":100,"run_number":7,"head_branch":"main","head_sha":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","event":"push","path":".github/workflows/abi-staging-pages-canary.yml"}]}'

echo "test-pages-run-freshness: ok"
