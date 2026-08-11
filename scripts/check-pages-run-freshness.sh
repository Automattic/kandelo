#!/usr/bin/env bash
set -euo pipefail

WORKFLOW_FILE="${PAGES_WORKFLOW_FILE:-browser-demos-pages.yml}"
REPOSITORY="${GITHUB_REPOSITORY:?GITHUB_REPOSITORY is required}"
RUN_ID="${GITHUB_RUN_ID:?GITHUB_RUN_ID is required}"
RUN_NUMBER="${GITHUB_RUN_NUMBER:?GITHUB_RUN_NUMBER is required}"
OUTPUT_FILE="${GITHUB_OUTPUT:?GITHUB_OUTPUT is required}"
: "${GH_TOKEN:?GH_TOKEN is required}"
CANARY_WORKFLOW_FILE="abi-staging-pages-canary.yml"
CANARY_WORKFLOW_PATH=".github/workflows/$CANARY_WORKFLOW_FILE"
CANARY_WORKFLOW_REF="Automattic/kandelo/$CANARY_WORKFLOW_PATH@refs/heads/main"

fail() {
  echo "check-pages-run-freshness: $*" >&2
  exit 1
}

[[ "$REPOSITORY" =~ ^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$ ]] ||
  fail "invalid GITHUB_REPOSITORY: $REPOSITORY"
[[ "$WORKFLOW_FILE" =~ ^[A-Za-z0-9_.-]+\.ya?ml$ ]] ||
  fail "invalid workflow filename: $WORKFLOW_FILE"
[[ "$RUN_ID" =~ ^[1-9][0-9]*$ ]] ||
  fail "invalid GITHUB_RUN_ID: $RUN_ID"
[[ "$RUN_NUMBER" =~ ^[1-9][0-9]*$ ]] ||
  fail "invalid GITHUB_RUN_NUMBER: $RUN_NUMBER"

output_name="publish"
if [ "$WORKFLOW_FILE" = "$CANARY_WORKFLOW_FILE" ]; then
  SOURCE_SHA="${GITHUB_SHA:?GITHUB_SHA is required for the Pages canary}"
  SOURCE_REF="${GITHUB_REF:?GITHUB_REF is required for the Pages canary}"
  EVENT_NAME="${GITHUB_EVENT_NAME:?GITHUB_EVENT_NAME is required for the Pages canary}"
  WORKFLOW_REF="${GITHUB_WORKFLOW_REF:?GITHUB_WORKFLOW_REF is required for the Pages canary}"
  [ "$REPOSITORY" = "Automattic/kandelo" ] ||
    fail "canary requires protected repository Automattic/kandelo"
  if [ "$SOURCE_REF" != "refs/heads/main" ] || [ "$EVENT_NAME" != "push" ] ||
     ! [[ "$SOURCE_SHA" =~ ^[0-9a-f]{40}$ ]]; then
    fail "canary requires one protected main push"
  fi
  [ "$WORKFLOW_REF" = "$CANARY_WORKFLOW_REF" ] ||
    fail "canary requires its protected workflow ref"
  output_name="upload"
fi

response_file="$(mktemp "${TMPDIR:-/tmp}/kandelo-pages-runs.XXXXXX")"
cleanup() {
  case "$response_file" in
    "${TMPDIR:-/tmp}"/kandelo-pages-runs.*)
      rm -f -- "$response_file"
      ;;
  esac
}
trap cleanup EXIT

endpoint="/repos/$REPOSITORY/actions/workflows/$WORKFLOW_FILE/runs"
if ! gh api --method GET "$endpoint" \
  -f branch=main \
  -f per_page=100 >"$response_file"; then
  fail "GitHub Actions workflow-runs API request failed"
fi

jq -e --arg workflow_file "$WORKFLOW_FILE" --arg canary "$CANARY_WORKFLOW_FILE" \
  --arg canary_path "$CANARY_WORKFLOW_PATH" '
  (.workflow_runs | type == "array" and length > 0) and
  all(.workflow_runs[];
    (.id | type == "number" and . >= 1 and . == floor) and
    (.run_number | type == "number" and . >= 1 and . == floor) and
    .head_branch == "main" and
    ($workflow_file != $canary or (
      (.head_sha | type == "string" and test("^[0-9a-f]{40}$")) and
      .event == "push" and
      .path == $canary_path
    )))
' "$response_file" >/dev/null ||
  fail "workflow-runs API response is empty or malformed"

current_matches="$(
  jq --argjson run_id "$RUN_ID" \
    '[.workflow_runs[] | select(.id == $run_id)] | length' \
    "$response_file"
)"
[ "$current_matches" -eq 1 ] ||
  fail "current workflow run $RUN_ID is missing or duplicated in the API response"

api_run_number="$(
  jq -r --argjson run_id "$RUN_ID" \
    '.workflow_runs[] | select(.id == $run_id) | .run_number' \
    "$response_file"
)"
[ "$api_run_number" -eq "$RUN_NUMBER" ] ||
  fail "current run number does not match the API response"

if [ "$WORKFLOW_FILE" = "$CANARY_WORKFLOW_FILE" ]; then
  jq -e \
    --argjson run_id "$RUN_ID" \
    --arg source_sha "$SOURCE_SHA" \
    --arg path "$CANARY_WORKFLOW_PATH" '
      .workflow_runs[] |
      select(.id == $run_id) |
      .head_branch == "main" and
      .head_sha == $source_sha and
      .event == "push" and
      .path == $path
    ' "$response_file" >/dev/null ||
    fail "current canary run differs from its exact event source"
fi

newest_run_number="$(
  jq -r '[.workflow_runs[].run_number] | max' "$response_file"
)"
if [ "$newest_run_number" -gt "$RUN_NUMBER" ]; then
  echo "$output_name=false" >>"$OUTPUT_FILE"
  echo "::notice title=Superseded Pages run::Skipping run $RUN_NUMBER because Pages run $newest_run_number was triggered later"
  exit 0
fi
[ "$newest_run_number" -eq "$RUN_NUMBER" ] ||
  fail "workflow-runs API returned an impossible newest run number"

echo "$output_name=true" >>"$OUTPUT_FILE"
echo "check-pages-run-freshness: run $RUN_NUMBER is the newest triggered Pages run"
