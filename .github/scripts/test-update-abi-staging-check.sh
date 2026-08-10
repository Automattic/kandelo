#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT=$(git rev-parse --show-toplevel)
UPDATER="$REPO_ROOT/.github/scripts/update-abi-staging-check.sh"
TMP_ROOT=$(mktemp -d)
trap 'rm -rf "$TMP_ROOT"' EXIT

fail() {
  echo "test-update-abi-staging-check: $*" >&2
  exit 1
}

[[ -x $UPDATER ]] || fail "updater is absent or not executable"

mkdir -p "$TMP_ROOT/bin"
cat >"$TMP_ROOT/bin/gh" <<'FAKE_GH'
#!/usr/bin/env bash
set -euo pipefail

printf '%q ' "$@" >>"$FAKE_STATE/calls.log"
printf '\n' >>"$FAKE_STATE/calls.log"
[[ ${1:-} == api ]] || {
  echo "fake gh: only api is allowed" >&2
  exit 2
}
shift
method=GET
endpoint=
fields=()
while (($#)); do
  case "$1" in
    --method) method=${2:-}; shift 2 ;;
    --paginate|--slurp) shift ;;
    -H) shift 2 ;;
    -f|-F) fields+=("${2:-}"); shift 2 ;;
    *) endpoint=$1; shift ;;
  esac
done
printf '%s %s' "$method" "$endpoint" >>"$FAKE_STATE/api.log"
for field in "${fields[@]}"; do printf ' %q' "$field" >>"$FAKE_STATE/api.log"; done
printf '\n' >>"$FAKE_STATE/api.log"

case "$method:$endpoint" in
  GET:*/commits/*/check-runs\?*)
    case "$FAKE_CHECK_MODE" in
      none) printf '[{"total_count":0,"check_runs":[]}]\n' ;;
      same)
        jq -cn --arg external "$EXPECT_EXTERNAL" \
          '[{total_count:1,check_runs:[{id:71,name:"Kandelo PR Check",head_sha:$ENV.EXPECT_HEAD,external_id:$external}]}]'
        ;;
      other)
        jq -cn \
          '[{total_count:1,check_runs:[{id:72,name:"Kandelo PR Check",head_sha:$ENV.EXPECT_HEAD,external_id:"abi-staging:old"}]}]'
        ;;
      duplicate)
        jq -cn --arg external "$EXPECT_EXTERNAL" \
          '[{total_count:2,check_runs:[{id:71,name:"Kandelo PR Check",head_sha:$ENV.EXPECT_HEAD,external_id:$external},{id:72,name:"Kandelo PR Check",head_sha:$ENV.EXPECT_HEAD,external_id:$external}]}]'
        ;;
      paginated)
        jq -cn --arg external "$EXPECT_EXTERNAL" \
          '[{total_count:1,check_runs:[]},{total_count:1,check_runs:[{id:73,name:"Kandelo PR Check",head_sha:$ENV.EXPECT_HEAD,external_id:$external}]}]'
        ;;
      sentinel)
        sentinel="abi-staging:19:${EXPECT_HEAD}:$(printf '0%.0s' {1..64})"
        jq -cn --arg external "$sentinel" \
          '[{total_count:1,check_runs:[{id:74,name:"Kandelo PR Check",head_sha:$ENV.EXPECT_HEAD,external_id:$external}]}]'
        ;;
      *) exit 2 ;;
    esac
    ;;
  GET:*/pulls/*)
    head=$EXPECT_HEAD
    [[ ${FAKE_STALE_HEAD:-0} == 0 ]] || head=$(printf '9%.0s' {1..40})
    jq -cn --arg head "$head" --arg repository "$EXPECT_REPOSITORY" \
      '{state:"open",head:{sha:$head,repo:{full_name:$repository}}}'
    ;;
  POST:*/check-runs)
    [[ ${FAKE_WRITE_FAILURE:-0} == 0 ]] || exit 1
    printf '{"id":81}\n'
    ;;
  PATCH:*/check-runs/*)
    [[ ${FAKE_WRITE_FAILURE:-0} == 0 ]] || exit 1
    printf '{"id":82}\n'
    ;;
  *)
    echo "fake gh: unexpected $method $endpoint" >&2
    exit 2
    ;;
esac
FAKE_GH
chmod +x "$TMP_ROOT/bin/gh"

HEAD_SHA=$(printf '1%.0s' {1..40})
REQUEST_DIGEST=$(printf '2%.0s' {1..64})
REPOSITORY=Automattic/kandelo
EXTERNAL_ID="abi-staging:19:${HEAD_SHA}:${REQUEST_DIGEST}"

write_projection() {
  local conclusion=$1 output=$2
  local computed=$conclusion
  case "$conclusion" in
    in_progress) computed=pending ;;
    neutral) computed=failure ;;
  esac
  jq -cnS \
    --arg computed "$computed" \
    --arg conclusion "$conclusion" \
    --arg external "$EXTERNAL_ID" \
    --arg head "$HEAD_SHA" '
      {
        background: [],
        blockers: [],
        computed_conclusion: $computed,
        details_markdown: "## Details\n\nBounded.\n",
        discovery_delayed: false,
        external_id: $external,
        head_sha: $head,
        name: "Kandelo PR Check",
        published_conclusion: $conclusion,
        required_formulae: [],
        required_products: [],
        summary_markdown: "## Kandelo PR Check\n\nBounded.\n"
      }
    ' >"$output"
}

run_case() {
  local name=$1 check_mode=$2 conclusion=$3 expected=$4 expected_method=$5
  local state="$TMP_ROOT/$name"
  mkdir -p "$state"
  write_projection "$conclusion" "$state/projection.json"
  if env PATH="$TMP_ROOT/bin:$PATH" GH_TOKEN=test-token \
    FAKE_STATE="$state" FAKE_CHECK_MODE="$check_mode" \
    EXPECT_EXTERNAL="$EXTERNAL_ID" EXPECT_HEAD="$HEAD_SHA" \
    EXPECT_REPOSITORY="$REPOSITORY" \
    "$UPDATER" --repository "$REPOSITORY" --pull-request 19 \
      --projection "$state/projection.json"; then
    [[ $expected == success ]] || fail "$name unexpectedly succeeded"
  else
    [[ $expected == failure ]] || fail "$name unexpectedly failed"
  fi
  if [[ $expected == success ]]; then
    grep -Fq "$expected_method /repos/$REPOSITORY/check-runs" "$state/api.log" ||
      fail "$name did not use expected write method"
    grep -Fq "GET /repos/$REPOSITORY/pulls/19" "$state/api.log" ||
      fail "$name omitted the immediate head recheck"
    local head_line write_line
    head_line=$(grep -nF "GET /repos/$REPOSITORY/pulls/19" "$state/api.log" | tail -1 | cut -d: -f1)
    write_line=$(grep -nE '^(POST|PATCH) .*/check-runs' "$state/api.log" | tail -1 | cut -d: -f1)
    ((head_line < write_line)) || fail "$name wrote before the final head recheck"
  fi
}

run_case create none success success POST
run_case update same success success PATCH
run_case old-head-irrelevant other success success POST
run_case pagination paginated success success PATCH
run_case supersede-missing sentinel success success PATCH
run_case duplicate duplicate success failure NONE

run_case pending none in_progress success POST
grep -Fq 'status=in_progress' "$TMP_ROOT/pending/api.log" || fail "pending Check was not in progress"
! grep -Fq 'conclusion=' "$TMP_ROOT/pending/api.log" || fail "pending Check carried a conclusion"

run_case observe none neutral success POST
grep -Fq 'status=completed' "$TMP_ROOT/observe/api.log" || fail "observe Check was not completed"
grep -Fq 'conclusion=neutral' "$TMP_ROOT/observe/api.log" || fail "observe Check was not neutral"

state="$TMP_ROOT/stale-head"
mkdir -p "$state"
write_projection success "$state/projection.json"
if env PATH="$TMP_ROOT/bin:$PATH" GH_TOKEN=test-token FAKE_STATE="$state" \
  FAKE_CHECK_MODE=none FAKE_STALE_HEAD=1 EXPECT_EXTERNAL="$EXTERNAL_ID" \
  EXPECT_HEAD="$HEAD_SHA" EXPECT_REPOSITORY="$REPOSITORY" \
  "$UPDATER" --repository "$REPOSITORY" --pull-request 19 \
    --projection "$state/projection.json"; then
  fail "stale head unexpectedly wrote a Check"
fi
! grep -Eq '^(POST|PATCH) .*/check-runs' "$state/api.log" ||
  fail "stale head reached a write"

state="$TMP_ROOT/write-failure"
mkdir -p "$state"
write_projection failure "$state/projection.json"
if env PATH="$TMP_ROOT/bin:$PATH" GH_TOKEN=test-token FAKE_STATE="$state" \
  FAKE_CHECK_MODE=none FAKE_WRITE_FAILURE=1 EXPECT_EXTERNAL="$EXTERNAL_ID" \
  EXPECT_HEAD="$HEAD_SHA" EXPECT_REPOSITORY="$REPOSITORY" \
  "$UPDATER" --repository "$REPOSITORY" --pull-request 19 \
    --projection "$state/projection.json"; then
  fail "failed GitHub write was swallowed"
fi

if grep -ERq -- '--clobber|/latest|method DELETE|refs/tags' "$TMP_ROOT"/*/calls.log; then
  fail "updater used a mutable or destructive API"
fi

echo "test-update-abi-staging-check: PASS"
