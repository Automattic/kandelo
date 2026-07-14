#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
VERIFY="$SCRIPT_DIR/require-exact-head-approval.sh"
TMP_ROOT="$(mktemp -d)"
trap 'rm -rf "$TMP_ROOT"' EXIT

BIN="$TMP_ROOT/bin"
DATA="$TMP_ROOT/data"
LOG="$TMP_ROOT/gh.log"
mkdir -p "$BIN" "$DATA"

HEAD="1111111111111111111111111111111111111111"
OLD_HEAD="2222222222222222222222222222222222222222"

cat > "$BIN/gh" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
printf '%s\n' "$*" >> "$GH_STUB_LOG"

case "${1:-}" in
  pr)
    [ "${2:-}" = view ] || exit 99
    printf '%s\n' "${GH_STUB_DECISION:-APPROVED}"
    ;;
  api)
    endpoint=""
    for arg in "$@"; do
      case "$arg" in /repos/*) endpoint="$arg" ;; esac
    done
    case "$endpoint" in
      /repos/example/repo/pulls/1)
        cat "$GH_STUB_DATA/pr.json"
        ;;
      /repos/example/repo/pulls/1/reviews\?per_page=100)
        cat "$GH_STUB_DATA/reviews.json"
        ;;
      /repos/example/repo/collaborators/*/permission)
        reviewer="${endpoint#/repos/example/repo/collaborators/}"
        reviewer="${reviewer%/permission}"
        jq -n --arg permission "$(cat "$GH_STUB_DATA/permission-$reviewer")" \
          '{permission: $permission}'
        ;;
      *) exit 99 ;;
    esac
    ;;
  *) exit 99 ;;
esac
EOF
chmod +x "$BIN/gh"

jq -n --arg head "$HEAD" '{head: {sha: $head}, user: {login: "author"}}' \
  > "$DATA/pr.json"
printf 'write\n' > "$DATA/permission-qualified"
printf 'read\n' > "$DATA/permission-outsider"

run_verify() {
  : > "$LOG"
  GITHUB_REPOSITORY=example/repo \
  GH_STUB_DATA="$DATA" \
  GH_STUB_LOG="$LOG" \
  APPROVAL_RETRY_DELAY_SECONDS=0 \
  PATH="$BIN:$PATH" \
  "$VERIFY" --pr-number 1 --head-sha "$HEAD"
}

review() {
  local state="$1"
  local commit="$2"
  local login="$3"
  jq -n --arg state "$state" --arg commit "$commit" --arg login "$login" \
    '{state: $state, commit_id: $commit, user: {login: $login}}'
}

# A qualified approval on an older head cannot authorize the tested head even
# when GitHub's aggregate decision remains APPROVED.
jq -n --argjson old "$(review APPROVED "$OLD_HEAD" qualified)" \
  '[[$old]]' > "$DATA/reviews.json"
if run_verify >"$TMP_ROOT/old.out" 2>"$TMP_ROOT/old.err"; then
  echo "old-head approval authorized the tested head" >&2
  exit 1
fi
grep -q 'no qualified non-dismissed approval' "$TMP_ROOT/old.err"

# GitHub represents a dismissed review with state DISMISSED; it is never an
# exact-head approval even if its original commit matches.
jq -n --argjson dismissed "$(review DISMISSED "$HEAD" qualified)" \
  '[[$dismissed]]' > "$DATA/reviews.json"
if run_verify >"$TMP_ROOT/dismissed.out" 2>"$TMP_ROOT/dismissed.err"; then
  echo "dismissed approval authorized the tested head" >&2
  exit 1
fi
grep -q 'no qualified non-dismissed approval' "$TMP_ROOT/dismissed.err"

# An unqualified exact-head approval cannot piggyback an older qualified
# approval that keeps the aggregate reviewDecision at APPROVED.
jq -n \
  --argjson old "$(review APPROVED "$OLD_HEAD" qualified)" \
  --argjson current "$(review APPROVED "$HEAD" outsider)" \
  '[[$old, $current]]' > "$DATA/reviews.json"
if run_verify >"$TMP_ROOT/unqualified.out" 2>"$TMP_ROOT/unqualified.err"; then
  echo "unqualified exact-head approval was accepted" >&2
  exit 1
fi
grep -q 'no qualified non-dismissed approval' "$TMP_ROOT/unqualified.err"

# A qualified approval on the exact tested head is accepted even when it is on
# a later reviews page, proving the paginated response is consumed.
jq -n \
  --argjson old "$(review APPROVED "$OLD_HEAD" qualified)" \
  --argjson current "$(review APPROVED "$HEAD" qualified)" \
  '[[$old], [$current]]' > "$DATA/reviews.json"
run_verify > "$TMP_ROOT/accepted.out"
grep -q "qualified reviewer qualified approved exact head $HEAD" "$TMP_ROOT/accepted.out"
grep -Fq 'api --paginate --slurp /repos/example/repo/pulls/1/reviews?per_page=100' "$LOG"

# An exact approval never overrides an aggregate CHANGES_REQUESTED decision.
if GH_STUB_DECISION=CHANGES_REQUESTED \
    run_verify >"$TMP_ROOT/changes.out" 2>"$TMP_ROOT/changes.err"
then
  echo "exact-head approval bypassed CHANGES_REQUESTED" >&2
  exit 1
fi
grep -q 'review decision is CHANGES_REQUESTED' "$TMP_ROOT/changes.err"

echo "exact-head approval tests passed"
