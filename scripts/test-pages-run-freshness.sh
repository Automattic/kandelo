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

expected="api --method GET /repos/Automattic/kandelo/actions/workflows/browser-demos-pages.yml/runs -f branch=main -f per_page=100"
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

echo "test-pages-run-freshness: ok"
