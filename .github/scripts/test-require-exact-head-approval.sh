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
        count_file="$GH_STUB_DATA/pr-call-count"
        count=0
        [ ! -f "$count_file" ] || count=$(cat "$count_file")
        count=$((count + 1))
        printf '%s\n' "$count" > "$count_file"
        if [ "$count" -gt 1 ] && [ -f "$GH_STUB_DATA/pr-final.json" ]; then
          cat "$GH_STUB_DATA/pr-final.json"
        else
          cat "$GH_STUB_DATA/pr.json"
        fi
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
printf 'admin\n' > "$DATA/permission-author"
printf 'maintain\n' > "$DATA/permission-maintainer"
printf 'write\n' > "$DATA/permission-writer"

run_verify() {
  local label_actor="${1:-}"
  local -a args=(--pr-number 1 --head-sha "$HEAD")
  if [ -n "$label_actor" ]; then
    args+=(--label-actor "$label_actor")
  fi
  : > "$LOG"
  rm -f "$DATA/pr-call-count"
  GITHUB_REPOSITORY=example/repo \
  GH_STUB_DATA="$DATA" \
  GH_STUB_LOG="$LOG" \
  APPROVAL_RETRY_DELAY_SECONDS=0 \
  PATH="$BIN:$PATH" \
  "$VERIFY" "${args[@]}"
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

# Applying ready-to-ship is an exact-head attestation when the event sender is
# a repository maintainer or admin. It does not require a synthetic self-review.
printf '[[]]\n' > "$DATA/reviews.json"
GH_STUB_DECISION=REVIEW_REQUIRED \
  run_verify author > "$TMP_ROOT/admin-attestation.out"
grep -q "qualified maintainer author attested exact head $HEAD" \
  "$TMP_ROOT/admin-attestation.out"

GH_STUB_DECISION=REVIEW_REQUIRED \
  run_verify maintainer > "$TMP_ROOT/maintainer-attestation.out"
grep -q "qualified maintainer maintainer attested exact head $HEAD" \
  "$TMP_ROOT/maintainer-attestation.out"

# Ordinary write permission can qualify a real exact-head review, but cannot
# turn a label application into maintainer self-attestation.
if GH_STUB_DECISION=REVIEW_REQUIRED \
    run_verify writer >"$TMP_ROOT/writer.out" 2>"$TMP_ROOT/writer.err"
then
  echo "write-level label actor bypassed exact-head review" >&2
  exit 1
fi
grep -q 'label actor is not a maintainer' "$TMP_ROOT/writer.err"

# The verifier re-reads the PR immediately before accepting a maintainer
# attestation, so a concurrent push invalidates the label event.
jq -n --arg head "$OLD_HEAD" '{head: {sha: $head}, user: {login: "author"}}' \
  > "$DATA/pr-final.json"
if GH_STUB_DECISION=REVIEW_REQUIRED \
    run_verify author >"$TMP_ROOT/drift.out" 2>"$TMP_ROOT/drift.err"
then
  echo "maintainer attestation survived a concurrent head change" >&2
  exit 1
fi
grep -q 'advanced from tested head.*during maintainer attestation' "$TMP_ROOT/drift.err"
rm -f "$DATA/pr-final.json"

if run_verify 'bad actor' >"$TMP_ROOT/actor.out" 2>"$TMP_ROOT/actor.err"; then
  echo "malformed label actor was accepted" >&2
  exit 1
fi
grep -q -- '--label-actor must be a GitHub login' "$TMP_ROOT/actor.err"

# An exact approval never overrides an aggregate CHANGES_REQUESTED decision.
if GH_STUB_DECISION=CHANGES_REQUESTED \
    run_verify >"$TMP_ROOT/changes.out" 2>"$TMP_ROOT/changes.err"
then
  echo "exact-head approval bypassed CHANGES_REQUESTED" >&2
  exit 1
fi
grep -q 'outstanding CHANGES_REQUESTED' "$TMP_ROOT/changes.err"

# A maintainer label application also cannot override requested changes.
if GH_STUB_DECISION=CHANGES_REQUESTED \
    run_verify author >"$TMP_ROOT/maintainer-changes.out" 2>"$TMP_ROOT/maintainer-changes.err"
then
  echo "maintainer attestation bypassed CHANGES_REQUESTED" >&2
  exit 1
fi
grep -q 'outstanding CHANGES_REQUESTED' "$TMP_ROOT/maintainer-changes.err"

echo "exact-head approval tests passed"
